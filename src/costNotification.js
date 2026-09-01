import { IncomingWebhook } from '@slack/webhook';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import moment from 'moment/moment';

const url = process.env.SLACK_WEBHOOK_URL;
const webhook = new IncomingWebhook(url);

const ce = new CostExplorerClient({ region: 'us-east-1' });

export const handler = async (event) => {

  const now = moment();
  const start = now.format('YYYY-MM-01');
  const end = now.add(1, 'month').format('YYYY-MM-01');

  const params = {
    TimePeriod: {
      Start: start,
      End: end,
    },
    Granularity: 'MONTHLY',
    Metrics: ['UnblendedCost'],
  };

  const data = await ce.send(new GetCostAndUsageCommand(params));
  console.log('Cost data:', JSON.stringify(data, null, 2));

  const cost = data.ResultsByTime[0].Total.UnblendedCost.Amount;
  const message = `今月のAWS利用費: $${cost}`;

  await webhook.send({
    text: message,
  });
}
