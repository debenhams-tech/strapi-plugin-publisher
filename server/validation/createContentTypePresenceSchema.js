'use strict';

const yup = require('yup');

// Same string types the admin's own createYupSchema (admin/src/utils/schema.js)
// treats as string-shaped, minus 'enumeration' (kept separate below since it
// gets its own yup.string() call regardless of an enum list being present)
const STRING_TYPES = new Set(['string', 'text', 'richtext', 'email', 'password', 'uid']);

// Relation values aren't reliably available here (they'd need explicit
// population per attribute), so - matching the admin's own schema builders -
// they're left out of the presence check entirely rather than guessed at
const SKIPPED_TYPES = new Set(['relation']);

const MAX_DEPTH = 12;

/**
 * Builds a Yup schema that models ONLY presence/required-ness for a content
 * type's real attribute schema (including nested/repeatable components and
 * dynamic zones, resolved by `__component`) - not minLength/maxLength/regex/
 * enum-membership/number ranges. Ported from this app's own
 * `invalid-content-pill` admin plugin's `createContentTypeSchema.ts`, kept
 * deliberately narrower here: this result is used to decide which fields to
 * blank out before running Strapi's own `entityValidator` (see
 * `validate-scheduled-publish.js`), and blanking a field that merely fails a
 * non-required-related rule (e.g. a too-short but optional field) would make
 * `entityValidator` treat it as absent and silently let it through - worse
 * than not checking it at all. Only "is this required thing actually filled
 * in" is safe to fold into that blank-and-let-entityValidator-catch-it trick.
 *
 * The reason this exists at all: yup's own `.required()` correctly rejects
 * an empty string or an empty required array, whereas Strapi's own
 * `entityValidator` uses custom `notNil`/`notNull` checks (only null/
 * undefined) and, for dynamic zones/repeatable components without an
 * explicit `min`, a required check that's a no-op due to an `||` where an
 * `&&` was clearly intended - see the comment above `blankOutMissingRequiredFields`
 * in `validate-scheduled-publish.js`.
 *
 */
const buildFieldSchema = (attribute, componentsByUid, depth) => {
	if (attribute.type === 'component') {
		const nestedAttributes = attribute.component
			? (componentsByUid[attribute.component] || {}).attributes
			: undefined;
		const itemSchema = buildComponentSchema(nestedAttributes, componentsByUid, depth + 1);

		if (attribute.repeatable) {
			let arraySchema = yup.array().of(itemSchema).nullable();

			if (attribute.required) {
				arraySchema = arraySchema.required().min(1);
			}

			return arraySchema;
		}

		return attribute.required ? itemSchema.required() : itemSchema.nullable();
	}

	if (attribute.type === 'dynamiczone') {
		let arraySchema = yup
			.array()
			.of(
				yup.lazy((value) => {
					const nestedAttributes =
						value && value.__component ? (componentsByUid[value.__component] || {}).attributes : undefined;

					return buildComponentSchema(nestedAttributes, componentsByUid, depth + 1);
				})
			)
			.nullable();

		if (attribute.required) {
			arraySchema = arraySchema.required().min(1);
		}

		return arraySchema;
	}

	if (STRING_TYPES.has(attribute.type) || attribute.type === 'enumeration') {
		const schema = yup.string();

		return attribute.required ? schema.required() : schema.nullable();
	}

	// numbers, booleans, dates, json, media, and anything else not modelled
	// above: entityValidator's own required checks for these already
	// correctly treat 0/false as present, so a plain presence check adds
	// nothing beyond what entityValidator does natively for these types
	const schema = yup.mixed();

	return attribute.required ? schema.required() : schema.notRequired();
};

const buildComponentSchema = (attributes, componentsByUid, depth = 0) => {
	if (!attributes || depth > MAX_DEPTH) {
		return yup.mixed().notRequired();
	}

	const shape = {};

	Object.entries(attributes).forEach(([name, attribute]) => {
		if (SKIPPED_TYPES.has(attribute.type)) {
			return;
		}

		shape[name] = buildFieldSchema(attribute, componentsByUid, depth);
	});

	return yup.object().shape(shape);
};

const createContentTypePresenceSchema = (attributes, componentsByUid) =>
	buildComponentSchema(attributes, componentsByUid);

module.exports = { createContentTypePresenceSchema };
