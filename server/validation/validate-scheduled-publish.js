'use strict';

const _ = require('lodash');
const { errors } = require('@strapi/utils');
const { getPluginService } = require('../utils/getPluginService');
const { getPluginEntityUid } = require('../utils/getEntityUId');
const { getDeepPopulate } = require('../utils/populate');
const { createContentTypePresenceSchema } = require('./createContentTypePresenceSchema');

const actionUId = getPluginEntityUid('action');

const SAVE_BLOCKED_MESSAGE =
	'Cannot save: a publish is scheduled for this entry, and one or more required fields are missing or empty.';

// entityValidator's own required checks (`notNil`/`notNull`, from
// @strapi/utils) only reject null/undefined, not an empty string - and for
// dynamic zones/repeatable components without an explicit `min`, its
// required check is `value !== null || value !== undefined`, which is
// *always true* (an `||` where an `&&` was clearly intended), so an empty
// array silently passes too. Media attributes get no required check at all:
// `createAttributeValidator` special-cases `isMediaAttribute` to a bare
// `yup.mixed()` with no `addRequiredValidation` call, unlike every other
// branch. `createContentTypePresenceSchema` models real "is this required
// thing actually filled in" semantics (yup's own `.required()` correctly
// rejects all three), so it's used here to find what entityValidator would
// miss and blank those specific values out first - entityValidator's *own*
// check then (correctly) treats them as missing, for everything except
// media, which it never checks regardless of value.
//
// Blanking is deliberately preferred over throwing our own error directly:
// constructing one would use this plugin's own copy of @strapi/utils, which
// - when npm link'ed for local development - is a different module instance
// than the host app's copy (Node resolves a symlinked package's
// dependencies from its own real path, not the app's node_modules). Strapi's
// error middleware checks `error instanceof strapiUtils.errors.ApplicationError`
// using the *app's* instance, so an error built from a different instance
// fails that check and gets masked as an opaque 500 instead of a proper 400.
// Letting entityValidator's own throw propagate avoids the mismatch entirely,
// since that error is always constructed from the app's own @strapi/strapi
// (never symlinked), matching what the middleware checks against. This only
// matters for the media fallback below, where there's no entityValidator
// check to delegate to at all - constructing our own error there is
// unavoidable, and works correctly in a real (non-linked) install.
const blankOutMissingRequiredFields = ({ strapi, contentType, data }) => {
	const schema = createContentTypePresenceSchema(contentType.attributes, strapi.components);

	try {
		schema.validateSync(data, { abortEarly: false });
		return { sanitizedData: data, presenceErrors: [] };
	} catch (error) {
		const sanitizedData = _.cloneDeep(data);

		error.inner.forEach((fieldError) => {
			if (fieldError.path) {
				_.set(sanitizedData, fieldError.path, undefined);
			}
		});

		// same shape @strapi/utils' own formatYupErrors produces (path as an
		// array, via lodash's toPath rather than yup's plain string path), so
		// this merges cleanly with entityValidator's own details.errors below
		const presenceErrors = error.inner.map((fieldError) => ({
			path: _.toPath(fieldError.path),
			message: fieldError.message,
			name: fieldError.name,
		}));

		return { sanitizedData, presenceErrors };
	}
};

/**
 * Blocks draft saves that would leave a content type invalid (missing
 * required fields, including inside dynamic zones/components, failed
 * relation checks, etc.) while a publish action is scheduled for that
 * entity, since the scheduled publish acts on whatever is persisted at
 * execution time.
 *
 * This decorates `entityService.update` rather than subscribing to
 * `strapi.db.lifecycles`. By the time a `beforeUpdate` DB lifecycle event
 * fires, Strapi has already decomposed dynamic zone/component data into
 * pivot-table references - the real field values for those items are no
 * longer present in `params.data` at that layer, only `{id, __component,
 * __pivot}` stubs. At the `entityService` level `params.data` is still the
 * raw payload as sent by the caller (e.g. the Content Manager), so it
 * carries full field data.
 *
 * Validation itself is delegated to Strapi's own `entityValidator` (the
 * same service `entityService.update` uses internally afterwards) rather
 * than reimplementing schema validation, so dynamic zones/components are
 * handled the same way core does and stay in sync with it. It already runs
 * with `abortEarly: false`, so every problem is reported in one pass rather
 * than one at a time across repeated saves. `blankOutMissingRequiredFields`
 * covers the specific gaps entityValidator's own required checks have -
 * see the comment above it.
 *
 * Saves that themselves touch `publishedAt` (native publish/unpublish, and
 * this plugin's own scheduled publish, which also goes through
 * `entityService.update`) are left alone, they're already validated by the
 * caller.
 *
 */
const registerScheduledPublishValidation = ({ strapi }) => {
	strapi.entityService.decorate((defaultService) => ({
		...defaultService,
		async update(uid, entityId, params = {}) {
			await validateIfScheduled({ strapi, uid, entityId, params });
			return defaultService.update(uid, entityId, params);
		},
	}));
};

const validateIfScheduled = async ({ strapi, uid, entityId, params }) => {
	if (uid === actionUId || entityId === undefined || entityId === null) {
		return;
	}

	// skip content types the plugin isn't even scoped to, same allowlist the
	// admin uses to decide whether to show the Publisher section at all
	const { contentTypes } = getPluginService('settingsService').get();

	if (contentTypes && contentTypes.length && !contentTypes.includes(uid)) {
		return;
	}

	const contentType = strapi.getModel(uid);

	if (!contentType || !(contentType.options && contentType.options.draftAndPublish)) {
		return;
	}

	if (params.data && 'publishedAt' in params.data) {
		return;
	}

	const pendingActions = await getPluginService('action').find({
		filters: {
			entityId,
			entitySlug: uid,
			mode: 'publish',
		},
		pagination: { limit: 1 },
	});

	if (!pendingActions.results.length) {
		return;
	}

	const existingEntity = await strapi.entityService.findOne(uid, entityId, {
		populate: getDeepPopulate(uid, {}),
	});
	const mergedData = { ...existingEntity, ...params.data };
	const { sanitizedData, presenceErrors } = blankOutMissingRequiredFields({
		strapi,
		contentType,
		data: mergedData,
	});

	let entityValidatorError = null;

	try {
		// "creation" semantics require every attribute to actually have a
		// value, whereas "update" semantics allow untouched fields to be
		// undefined (a plain partial update) - we want the former since
		// we're checking whether the full, merged entity is publish-ready
		await strapi.entityValidator.validateEntityCreation(
			contentType,
			sanitizedData,
			{ isDraft: false },
			existingEntity
		);
	} catch (error) {
		entityValidatorError = error;
	}

	if (entityValidatorError) {
		const entityValidatorPaths = new Set(
			((entityValidatorError.details && entityValidatorError.details.errors) || []).map((fieldError) =>
				fieldError.path.join('.')
			)
		);

		// only add presence errors entityValidator didn't already catch
		// itself once blanked out (e.g. a missing image alongside a missing
		// title) - otherwise every string/array field it *does* have a
		// working required check for would end up listed twice, once with
		// entityValidator's own wording and once with yup's
		const newPresenceErrors = presenceErrors.filter(
			(fieldError) => !entityValidatorPaths.has(fieldError.path.join('.'))
		);

		// mutate and re-throw the same error instance rather than
		// constructing a new one, so it stays `instanceof` the app's own
		// error classes - see the note above `blankOutMissingRequiredFields`
		// for why that matters. The top-level message is replaced rather
		// than appended to, since the admin has no way to highlight the
		// fields details.errors refers to - it would only show a raw field
		// path with nothing to act on
		entityValidatorError.details = {
			errors: [...((entityValidatorError.details && entityValidatorError.details.errors) || []), ...newPresenceErrors],
		};
		entityValidatorError.message = SAVE_BLOCKED_MESSAGE;
		throw entityValidatorError;
	}

	if (presenceErrors.length) {
		// entityValidator's own pass didn't throw at all - this happens for
		// things it has no required check for regardless of value (media,
		// see the comment above `blankOutMissingRequiredFields`), so there's
		// no existing app-instance error to piggyback on here. Constructing
		// our own is unavoidable, and works correctly in a real (non-linked)
		// install - see the same comment for the npm link caveat
		throw new errors.ValidationError(SAVE_BLOCKED_MESSAGE, { errors: presenceErrors });
	}
};

module.exports = { registerScheduledPublishValidation };
