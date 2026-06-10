// Always identify the calling bot so external services can attribute the
// request without requiring every flow to configure the header manually.
// A header explicitly set on the action takes precedence.
function addBotIdHeader(headers, chatbot) {
  const alreadySet = Object.keys(headers).some((key) => key.toLowerCase() === 'x-bot-id');
  const botId = resolveBotId(chatbot);
  if (!alreadySet && botId) {
    headers['X-Bot-Id'] = botId;
  }
  return headers;
}

// Published bots run on a snapshot copy (trashed=true) whose `root_id`
// points to the original bot, which is the id external systems know about.
function resolveBotId(chatbot) {
  if (!chatbot) {
    return null;
  }
  if (chatbot.bot && chatbot.bot.root_id) {
    return String(chatbot.bot.root_id);
  }
  return chatbot.botId ? String(chatbot.botId) : null;
}

module.exports = { addBotIdHeader };
