import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {simpleParser} from "mailparser";

const s3 = new S3Client();
const ses = new SESClient();
const sqs = new SQSClient();

const streamToString = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
};

export const handler = async (event) => {
  console.log("SES Event: ", JSON.stringify(event, null, 2));
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

  // Fetch the email from S3
  const { Body } = await s3.send(new GetObjectCommand({
    Bucket: bucketName,
    Key: objectKey
  }));

  // Convert the stream to a string
  const rawEmail = await streamToString(Body);
  console.log("Raw email content:\n", rawEmail);
  const emailData = await simpleParser(rawEmail);
  console.log({emailData});
  await ses.send(new SendEmailCommand({
    Source: 'me@eladheller.com',
    Destination: {
        ToAddresses: ['eladheller@gmail.com'],
    },
    ReplyToAddresses: [emailData.from.value[0].address],
    Message: {
      Body: {
        Html: {
          Data: emailData.html
        },
      },
      Subject: {
        Data: emailData.subject
      }
    },
  }));
  return { statusCode: 200 };
};
