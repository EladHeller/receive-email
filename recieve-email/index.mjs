import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import emailHandler from "./handler.mjs";
const sqs = new SQSClient();

export const handler = async (event, context) => {
  console.log("SES Event: ", JSON.stringify(event, null, 2));
  console.log("SES Context: ", JSON.stringify(context, null, 2));
  if (!event.Records) {
    return;
  }
  const sesNotification = event.Records[0].ses;
  const bucketName = 'eladheller-com-emails';
  const objectKey = sesNotification.mail.messageId;

   if (sesNotification.receipt.spfVerdict.status === 'FAIL'
            || sesNotification.receipt.dkimVerdict.status === 'FAIL'
            || sesNotification.receipt.spamVerdict.status === 'FAIL'
            || sesNotification.receipt.virusVerdict.status === 'FAIL') {
        console.log('Dropping spam');
        // Stop processing rule set, dropping message
        return { statusCode: 500 };
    }
    if (sesNotification.receipt.recipients[0] === 'sapper-bot@eladheller.com') {
        sqs.send(new SendMessageCommand({
            QueueUrl: process.env.SQS_QUEUE_URL,
            MessageBody: JSON.stringify({
                email: sesNotification.mail.commonHeaders,
                messageId: sesNotification.mail.messageId,
            }),
        }));
    }        

  console.log(`Fetching email from s3://${bucketName}/${objectKey}`);

  const overrides = {
    config: {
      fromEmail: "me@eladheller.com",
      emailBucket: bucketName,
      emailKeyPrefix: "",
      forwardMapping: {
        "@eladheller.com": [
          "eladheller@gmail.com",
        ],
      }
    }
  };
  await emailHandler(event, context, overrides);
};
