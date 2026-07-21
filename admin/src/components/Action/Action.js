import React, { useEffect, useState } from 'react';
import { useRBAC, useCMEditViewDataManager, useNotification } from '@strapi/helper-plugin';
import PropTypes from 'prop-types';
import { usePublisher } from '../../hooks/usePublisher';
import { Stack } from '@strapi/design-system';
import ActionTimePicker from './ActionDateTimePicker';
import ActionButtons from './ActionButtons/ActionButtons';
import { getTrad } from '../../utils/getTrad';
import { createYupSchema } from '../../utils/schema';

const Action = ({ mode, entityId, entitySlug }) => {
	const { createAction, getAction, updateAction, deleteAction } = usePublisher();
	const entity = useCMEditViewDataManager();
	const toggleNotification = useNotification();
	const [actionId, setActionId] = useState(0);
	const [isEditing, setIsEditing] = useState(false);
	const [executeAt, setExecuteAt] = useState(0);
	const [isCreating, setIsCreating] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [canPublish, setCanPublish] = useState(true);

	let schema;
	if (mode === 'publish') {
		const currentContentTypeLayout = entity.allLayoutData.contentType || {};
		schema = createYupSchema(
			currentContentTypeLayout,
			{ components: entity.allLayoutData.components || {} },
			{ isCreatingEntry: entity.isCreatingEntry, isDraft: false, isFromComponent: false }
		);
	}

	const { isLoading: isLoadingPermissions, allowedActions } = useRBAC({
		publish: [{ action: 'plugin::content-manager.explorer.publish', subject: entitySlug }],
	});

	useEffect(() => {
		if (!isLoadingPermissions) {
			setCanPublish(allowedActions.canPublish);
		}
	}, [isLoadingPermissions]);

	const {
		isLoading: isLoadingAction,
		data,
		isRefetching: isRefetchingAction,
	} = getAction({
		mode,
		entityId,
		entitySlug,
	});

	// set initial data to state so its reactive
	useEffect(() => {
		setIsLoading(true);
		if (!isLoadingAction && !isRefetchingAction) {
			setIsLoading(false);
			if (data) {
				setActionId(data.id);
				setExecuteAt(data.attributes.executeAt);
				setIsEditing(true);
			} else {
				setActionId(0);
			}
		}
	}, [isLoadingAction, isRefetchingAction]);

	// handlers
	function handleDateChange(date) {
		setExecuteAt(date);
	}

	async function isReadyToPublish() {
		if (mode !== 'publish' || !schema) {
			return true;
		}

		const isPageValid = await schema.isValid(entity.modifiedData);

		if (!isPageValid) {
			toggleNotification({
				type: 'warning',
				message: {
					id: getTrad('action.notification.publish.validation.incomplete'),
					defaultMessage: 'Required fields must be completed before a publish date can be set',
				},
			});
			return false;
		}

		const isSavedValid = await schema.isValid(entity.initialData);

		if (!isSavedValid) {
			toggleNotification({
				type: 'warning',
				message: {
					id: getTrad('action.notification.publish.validation.unsaved'),
					defaultMessage:
						'Save your changes before a publish date can be set — the scheduled publish uses the last saved version',
				},
			});
			return false;
		}

		return true;
	}

	async function handleOnEdit() {
		if (!(await isReadyToPublish())) {
			return;
		}
		setIsCreating(true);
		setIsEditing(false);
	}

	async function handleOnCreate() {
		if (!(await isReadyToPublish())) {
			return;
		}
		setIsCreating(true);
	}

	async function handleOnSave() {
		setIsLoading(true);
		try {
			if (!(await isReadyToPublish())) {
				return;
			}

			if (!actionId) {
				const { data: response } = await createAction({
					mode,
					entityId,
					entitySlug,
					executeAt,
				});

				if (response.data && response.data.id) {
					setActionId(response.data.id);
				}
			} else {
				await updateAction({ id: actionId, body: { executeAt } });
			}

			setIsCreating(false);
			setIsEditing(true);
		} catch (error) {
			console.error(error);
		} finally {
			setIsLoading(false);
		}
	}

	async function handleOnDelete() {
		try {
			await deleteAction({ id: actionId });
			setActionId(0);
			setExecuteAt(0);
			setIsCreating(false);
			setIsEditing(false);
		} catch (error) {
			console.error(error);
		}
	}

	return (
		<Stack spacing={2}>
			<ActionTimePicker
				onChange={handleDateChange}
				executeAt={executeAt}
				isCreating={isCreating}
				isEditing={isEditing}
				mode={mode}
			/>
			<ActionButtons
				mode={mode}
				onEdit={handleOnEdit}
				isEditing={isEditing}
				isCreating={isCreating}
				isLoading={isLoading}
				executeAt={executeAt}
				canPublish={canPublish}
				onCreate={handleOnCreate}
				onSave={handleOnSave}
				onDelete={handleOnDelete}
			/>
		</Stack>
	);
};

Action.propTypes = {
	mode: PropTypes.string.isRequired,
	entityId: PropTypes.number.isRequired,
	entitySlug: PropTypes.string.isRequired,
};

export default Action;
