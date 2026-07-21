'use strict';

const _ = require('lodash');
const { getPluginService } = require('../utils/getPluginService');
const { getPluginEntityUid } = require('../utils/getEntityUId');
const { getDeepPopulate } = require('../utils/populate');
const { createContentTypePresenceSchema } = require('./createContentTypePresenceSchema');

const actionUId = getPluginEntityUid('action');

// entityValidator's own required checks (`notNil`/`notNull`, from
// @strapi/utils) only reject null/undefined, not an empty string - and for
// dynamic zones/repeatable components without an explicit `min`, its
// required check is `value !== null || value !== undefined`, which is
// *always true* (an `||` where an `&&` was clearly intended), so an empty
// array silently passes too. `createContentTypePresenceSchema` models real
// "is this required thing actually filled in" semantics (yup's own
// `.required()` correctly rejects both), so it's used here to find what
// entityValidator would miss and blank those specific values out first -
// entityValidator's *own* check then (correctly) treats them as missing.
//
// This is deliberately *not* used to throw our own error directly:
// constructing one would use this plugin's own copy of @strapi/utils, which
// - when npm link'ed for local development - is a different module instance
// than the host app's copy (Node resolves a symlinked package's
// dependencies from its own real path, not the app's node_modules). Strapi's
// error middleware checks `error instanceof strapiUtils.errors.ApplicationError`
// using the *app's* instance, so an error built from a different instance
// fails that check and gets masked as an opaque 500 instead of a proper 400.
// Letting entityValidator's own throw propagate avoids the mismatch entirely,
// since that error is always constructed from the app's own @strapi/strapi
// (never symlinked), matching what the middleware checks against.
const blankOutMissingRequiredFields = ({ strapi, contentType, data }) => {
	const schema = createContentTypePresenceSchema(contentType.attributes, strapi.components);

	try {
		schema.validateSync(data, { abortEarly: false });
		return data;
	} catch (error) {
		const sanitized = _.cloneDeep(data);

		error.inner.forEach((fieldError) => {
			if (fieldError.path) {
				_.set(sanitized, fieldError.path, undefined);
			}
		});

		return sanitized;
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
	const sanitizedData = blankOutMissingRequiredFields({ strapi, contentType, data: mergedData });

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
		// re-throw the same error instance rather than wrapping it in a new
		// one, so it stays `instanceof` the app's own error classes - see the
		// note above `blankOutMissingRequiredFields` for why that matters.
		// The message is replaced rather than appended to, since the admin
		// has no way to highlight the specific fields this refers to - it
		// would only show a raw field path with nothing to act on
		error.message =
			'Cannot save: a publish is scheduled for this entry, and one or more required fields are missing or empty.';
		throw error;
	}
};

module.exports = { registerScheduledPublishValidation };
