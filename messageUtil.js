const messages = require('./messages.json');

/**
 * Retrieves a message based on category and key.
 * @param {string} category - The category of the message (e.g., 'users', 'dashboard').
 * @param {string} key - The key of the message (e.g., 'loadStatsSuccess').
 * @returns {string} The associated message or a default error message if not found.
 */
function getMessage(category, key) {
  if (messages[category] && messages[category][key]) {
    return messages[category][key];
  }
  return 'An unexpected error occurred.';
}

module.exports = { getMessage };
