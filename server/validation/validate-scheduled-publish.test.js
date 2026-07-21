'use strict';

const { errors } = require('@strapi/utils');
const { registerScheduledPublishValidation } = require('./validate-scheduled-publish');

// entityValidator's real behaviour, narrowed to what these tests exercise:
// rejects a missing/empty required string, never checks media at all
// (see the comment above `blankOutMissingRequiredFields` in
// validate-scheduled-publish.js for why that's the real Strapi behaviour,
// not a simplification of it).
const createFakeEntityValidator = () => ({
	validateEntityCreation: jest.fn(async (model, data) => {
		if (!data.title) {
			throw new errors.ValidationError('title must be defined.', {
				errors: [{ path: ['title'], message: 'title must be defined.', name: 'ValidationError' }],
			});
		}
		return data;
	}),
});

const setupFakeStrapi = ({
	contentTypeOptions = { draftAndPublish: true },
	pendingActions = [{ id: 1 }],
	settings = {},
	existingEntity = { id: 1, title: 'Existing', hero: { id: 9, url: 'existing.png' } },
	attributes = {
		title: { type: 'string', required: true },
		hero: { type: 'media', required: true },
	},
	components = {},
} = {}) => {
	let decoratedUpdate;

	const contentType = {
		uid: 'api::page.page',
		attributes,
		options: contentTypeOptions,
	};

	const entityValidator = createFakeEntityValidator();

	const strapi = {
		components,
		getModel: (uid) => (contentType.uid === uid ? contentType : components[uid]),
		entityValidator,
		entityService: {
			decorate(decorator) {
				const wrapped = decorator({
					update: jest.fn(async (uid, id, params) => ({ id, ...params.data })),
				});
				decoratedUpdate = wrapped.update;
				return strapi.entityService;
			},
			findOne: jest.fn(async () => existingEntity),
		},
		plugin: () => ({
			service: (name) => {
				if (name === 'settingsService') {
					return { get: () => settings };
				}
				if (name === 'action') {
					return { find: async () => ({ results: pendingActions }) };
				}
				throw new Error(`unexpected service requested in test: ${name}`);
			},
		}),
	};

	global.strapi = strapi;
	registerScheduledPublishValidation({ strapi });

	return {
		entityValidator,
		callUpdate: (data) => decoratedUpdate(contentType.uid, existingEntity.id, { data }),
	};
};

afterEach(() => {
	delete global.strapi;
});

describe('registerScheduledPublishValidation', () => {
	it('allows a save through when the entry is publish-ready', async () => {
		const { callUpdate } = setupFakeStrapi();

		await expect(callUpdate({ title: 'Hello', hero: { id: 1, url: 'x.png' } })).resolves.toBeDefined();
	});

	it('blocks a save with a missing required string field', async () => {
		const { callUpdate } = setupFakeStrapi();

		await expect(callUpdate({ title: '', hero: { id: 1, url: 'x.png' } })).rejects.toMatchObject({
			name: 'ValidationError',
		});
	});

	it('blocks a save with a missing required media field, via the fallback throw', async () => {
		const { callUpdate } = setupFakeStrapi();

		await expect(callUpdate({ title: 'Hello', hero: null })).rejects.toMatchObject({
			name: 'ValidationError',
			details: { errors: [{ path: ['hero'] }] },
		});
	});

	it('reports both problems, deduped, when a string and a media field are both missing', async () => {
		const { callUpdate } = setupFakeStrapi();

		try {
			await callUpdate({ title: '', hero: null });
			throw new Error('expected callUpdate to reject');
		} catch (error) {
			const paths = error.details.errors.map((fieldError) => fieldError.path.join('.'));

			expect(paths).toEqual(['title', 'hero']);
		}
	});

	it('skips content types without draftAndPublish enabled', async () => {
		const { callUpdate, entityValidator } = setupFakeStrapi({ contentTypeOptions: { draftAndPublish: false } });

		await expect(callUpdate({ title: '', hero: null })).resolves.toBeDefined();
		expect(entityValidator.validateEntityCreation).not.toHaveBeenCalled();
	});

	it('skips when no publish action is pending for the entity', async () => {
		const { callUpdate, entityValidator } = setupFakeStrapi({ pendingActions: [] });

		await expect(callUpdate({ title: '', hero: null })).resolves.toBeDefined();
		expect(entityValidator.validateEntityCreation).not.toHaveBeenCalled();
	});

	it('skips content types the plugin is not scoped to via settings.contentTypes', async () => {
		const { callUpdate, entityValidator } = setupFakeStrapi({
			settings: { contentTypes: ['api::other.other'] },
		});

		await expect(callUpdate({ title: '', hero: null })).resolves.toBeDefined();
		expect(entityValidator.validateEntityCreation).not.toHaveBeenCalled();
	});

	it('lets a save through untouched when it is itself a publish/unpublish (touches publishedAt)', async () => {
		const { callUpdate, entityValidator } = setupFakeStrapi();

		await expect(callUpdate({ title: '', hero: null, publishedAt: new Date() })).resolves.toBeDefined();
		expect(entityValidator.validateEntityCreation).not.toHaveBeenCalled();
	});

	it('blocks a save with a missing required media field nested inside a repeatable component within a dynamic zone item', async () => {
		const components = {
			'sections.gallery-section': {
				attributes: {
					gallery: { type: 'component', component: 'shared.gallery-item', repeatable: true, required: true },
				},
			},
			'shared.gallery-item': { attributes: { image: { type: 'media', required: true } } },
		};

		const { callUpdate } = setupFakeStrapi({
			attributes: {
				title: { type: 'string', required: true },
				content: { type: 'dynamiczone', required: true },
			},
			components,
			existingEntity: { id: 1, title: 'Existing', content: [] },
		});

		await expect(
			callUpdate({
				title: 'Hello',
				content: [
					{
						__component: 'sections.gallery-section',
						gallery: [{ image: { id: 1, url: 'a.png' } }, { image: null }],
					},
				],
			})
		).rejects.toMatchObject({
			name: 'ValidationError',
			details: { errors: [{ path: ['content', '0', 'gallery', '1', 'image'] }] },
		});
	});
});
