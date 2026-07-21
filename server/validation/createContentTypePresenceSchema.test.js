'use strict';

const { createContentTypePresenceSchema } = require('./createContentTypePresenceSchema');

const validate = (schema, data) => {
	try {
		schema.validateSync(data, { abortEarly: false });
		return [];
	} catch (error) {
		return error.inner.map((innerError) => innerError.path);
	}
};

describe('createContentTypePresenceSchema', () => {
	it('passes when all required top-level fields are filled', () => {
		const schema = createContentTypePresenceSchema(
			{ title: { type: 'string', required: true }, subtitle: { type: 'string' } },
			{}
		);

		expect(validate(schema, { title: 'Hello', subtitle: '' })).toEqual([]);
	});

	it('flags a missing required top-level field', () => {
		const schema = createContentTypePresenceSchema({ title: { type: 'string', required: true } }, {});

		expect(validate(schema, {})).toEqual(['title']);
	});

	it('flags an empty string on a required field', () => {
		const schema = createContentTypePresenceSchema({ title: { type: 'string', required: true } }, {});

		expect(validate(schema, { title: '' })).toEqual(['title']);
	});

	it('ignores relation fields entirely', () => {
		const schema = createContentTypePresenceSchema({ author: { type: 'relation', required: true } }, {});

		expect(validate(schema, {})).toEqual([]);
	});

	it('flags a missing required media field, unlike entityValidator', () => {
		const schema = createContentTypePresenceSchema({ hero: { type: 'media', required: true } }, {});

		expect(validate(schema, { hero: null })).toEqual(['hero']);
		expect(validate(schema, {})).toEqual(['hero']);
		expect(validate(schema, { hero: { id: 1, url: 'x.png' } })).toEqual([]);
	});

	it('does not require optional non-string, non-media fields to have a value', () => {
		const schema = createContentTypePresenceSchema({ rating: { type: 'integer' } }, {});

		expect(validate(schema, {})).toEqual([]);
	});

	it('flags a missing required field inside a non-repeatable component', () => {
		const components = {
			'shared.hero': { attributes: { heading: { type: 'string', required: true } } },
		};
		const schema = createContentTypePresenceSchema(
			{ hero: { type: 'component', component: 'shared.hero', required: true } },
			components
		);

		expect(validate(schema, { hero: null })).toEqual(['hero']);
		expect(validate(schema, { hero: { heading: '' } })).toEqual(['hero.heading']);
		expect(validate(schema, { hero: { heading: 'Welcome' } })).toEqual([]);
	});

	it('flags missing required fields inside repeatable component items', () => {
		const components = {
			'shared.card': { attributes: { label: { type: 'string', required: true } } },
		};
		const schema = createContentTypePresenceSchema(
			{ cards: { type: 'component', component: 'shared.card', repeatable: true, required: true } },
			components
		);

		expect(validate(schema, { cards: [] })).toEqual(['cards']);
		expect(validate(schema, { cards: [{ label: 'ok' }, { label: '' }] })).toEqual(['cards[1].label']);
	});

	it('flags missing required fields inside dynamic zone items, resolved by __component', () => {
		const components = {
			'sections.hero': { attributes: { heading: { type: 'string', required: true } } },
		};
		const schema = createContentTypePresenceSchema({ content: { type: 'dynamiczone', required: true } }, components);

		expect(validate(schema, { content: [] })).toEqual(['content']);
		expect(validate(schema, { content: [{ __component: 'sections.hero', heading: '' }] })).toEqual([
			'content[0].heading',
		]);
		expect(validate(schema, { content: [{ __component: 'sections.hero', heading: 'Hi' }] })).toEqual([]);
	});

	it('flags a missing required media field inside a repeatable component nested within a dynamic zone item', () => {
		const components = {
			'sections.gallery-section': {
				attributes: {
					gallery: { type: 'component', component: 'shared.gallery-item', repeatable: true, required: true },
				},
			},
			'shared.gallery-item': { attributes: { image: { type: 'media', required: true } } },
		};
		const schema = createContentTypePresenceSchema({ content: { type: 'dynamiczone', required: true } }, components);

		const withMissingImage = {
			content: [
				{
					__component: 'sections.gallery-section',
					gallery: [{ image: { id: 1, url: 'a.png' } }, { image: null }],
				},
			],
		};
		const withAllImages = {
			content: [
				{
					__component: 'sections.gallery-section',
					gallery: [{ image: { id: 1, url: 'a.png' } }, { image: { id: 2, url: 'b.png' } }],
				},
			],
		};

		expect(validate(schema, withMissingImage)).toEqual(['content[0].gallery[1].image']);
		expect(validate(schema, withAllImages)).toEqual([]);
	});
});
