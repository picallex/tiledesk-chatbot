// Always identify the calling bot so external services can attribute the
// request without requiring every flow to configure the header manually.
// A header explicitly set on the action takes precedence.
function addBotIdHeader(headers, chatbot) {
  const alreadySet = Object.keys(headers).some((key) => key.toLowerCase() === 'x-bot-id');
  if (!alreadySet && chatbot && chatbot.botId) {
    headers['X-Bot-Id'] = chatbot.botId;
  }
  return headers;
}

module.exports = { addBotIdHeader };
