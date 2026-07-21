'use strict';

const { registerCronTasks } = require('./config/cron-tasks');
const { registerScheduledPublishValidation } = require('./validation/validate-scheduled-publish');

module.exports = ({ strapi }) => {
	// register action check
	registerCronTasks({ strapi });

	// block draft saves that would break a pending scheduled publish
	registerScheduledPublishValidation({ strapi });
};
