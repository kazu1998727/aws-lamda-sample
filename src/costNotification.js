import { IncomingWebhook } from '@slack/webhook';

const url = process.env.SLACK_WEBHOOK_URL;
const webhook = new IncomingWebhook(url);

export const handler = async (event) => {
  await webhook.send({
    text: "I've got news for you...",
  });
}