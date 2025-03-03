"use strict";

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
const s3 = new S3Client({signatureVersion: 'v4'});
const ses = new SESv2Client();
console.log("AWS Lambda SES Forwarder // @arithmetric // Version 5.1.0");

const defaultConfig = {
  fromEmail: "noreply@example.com",
  subjectPrefix: "",
  emailBucket: "s3-bucket-name",
  emailKeyPrefix: "emailsPrefix/",
  allowPlusSign: true,
  forwardMapping: {
    "info@example.com": [
      "example.john@example.com",
      "example.jen@example.com"
    ],
    "abuse@example.com": [
      "example.jim@example.com"
    ],
    "@example.com": [
      "example.john@example.com"
    ],
    "info": [
      "info@example.com"
    ]
  }
};

/**
 * Parses the SES event record provided for the `mail` and `receipients` data.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
function parseEvent(data) {
  // Validate characteristics of a SES event record.
  if (!data.event ||
    !Object.hasOwn(data.event, 'Records') ||
    data.event.Records.length !== 1 ||
    !Object.hasOwn(data.event.Records[0], 'eventSource') ||
    data.event.Records[0].eventSource !== 'aws:ses' ||
    data.event.Records[0].eventVersion !== '1.0') {
    data.log({
      message: "parseEvent() received invalid SES message:",
      level: "error", event: JSON.stringify(data.event)
    });
    throw new Error('Error: Received invalid SES message.');
  }

  data.email = data.event.Records[0].ses.mail;
  data.recipients = data.event.Records[0].ses.receipt.recipients;
  return data;
};

/**
 * Transforms the original recipients to the desired forwarded destinations.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
function transformRecipients(data) {
  let newRecipients = [];
  data.originalRecipients = data.recipients;
  data.recipients.forEach(function(origEmail) {
    let origEmailKey = origEmail.toLowerCase();
    if (data.config.allowPlusSign) {
      origEmailKey = origEmailKey.replace(/\+.*?@/, '@');
    }
    if (Object.hasOwn(data.config.forwardMapping, origEmailKey)) {
      newRecipients = newRecipients.concat(
        data.config.forwardMapping[origEmailKey]);
      data.originalRecipient = origEmail;
    } else {
      let origEmailDomain;
      let origEmailUser;
      let pos = origEmailKey.lastIndexOf("@");
      if (pos === -1) {
        origEmailUser = origEmailKey;
      } else {
        origEmailDomain = origEmailKey.slice(pos);
        origEmailUser = origEmailKey.slice(0, pos);
      }
      if (origEmailDomain &&
        Object.hasOwn(data.config.forwardMapping, origEmailDomain)) {
        newRecipients = newRecipients.concat(
          data.config.forwardMapping[origEmailDomain]);
        data.originalRecipient = origEmail;
      } else if (origEmailUser &&
        Object.hasOwn(data.config.forwardMapping, origEmailUser)) {
        newRecipients = newRecipients.concat(
          data.config.forwardMapping[origEmailUser]);
        data.originalRecipient = origEmail;
      } else if (Object.hasOwn(data.config.forwardMapping, "@")) {
        newRecipients = newRecipients.concat(
          data.config.forwardMapping["@"]);
        data.originalRecipient = origEmail;
      }
    }
  });

  if (!newRecipients.length) {
    data.log({
      message: "Finishing process. No new recipients found for " +
        "original destinations: " + data.originalRecipients.join(", "),
      level: "info"
    });
    throw new Error("Error: No new recipients found.");
  }

  data.recipients = newRecipients;
  return data;
};

/**
 * Fetches the message data from S3.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
 async function fetchMessage(data) {
  try {
    const result = await s3.send(new GetObjectCommand({
      Bucket: data.config.emailBucket,
      Key: data.config.emailKeyPrefix + data.email.messageId
    }));
    data.emailData = await result.Body.transformToString();
    return data;  
  } catch (e) {
    data.log({
      level: "error",
      message: "GetObjectCommand() returned error:",
      error: e,
      stack: e.stack
    });
    throw new Error("Error: Failed to load message body from S3.");
  }
};

/**
 * Processes the message data, making updates to recipients and other headers
 * before forwarding message.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
function processMessage(data) {
  let match = data.emailData.match(/^((?:.+\r?\n)*)(\r?\n(?:.*\s+)*)/m);
  let header = match && match[1] ? match[1] : data.emailData;
  let body = match && match[2] ? match[2] : '';

  // Add "Reply-To:" with the "From" address if it doesn't already exists
  if (!/^reply-to:[\t ]?/mi.test(header)) {
    match = header.match(/^from:[\t ]?(.*(?:\r?\n\s+.*)*\r?\n)/mi);
    let from = match && match[1] ? match[1] : '';
    if (from) {
      header = header + 'Reply-To: ' + from;
      data.log({
        level: "info",
        message: "Added Reply-To address of: " + from
      });
    } else {
      data.log({
        level: "info",
        message: "Reply-To address not added because From address was not " +
          "properly extracted."
      });
    }
  }

  // SES does not allow sending messages from an unverified address,
  // so replace the message's "From:" header with the original
  // recipient (which is a verified domain)
  header = header.replace(
    /^from:[\t ]?(.*(?:\r?\n\s+.*)*)/mgi,
    function(match, from) {
      let fromText;
      if (data.config.fromEmail) {
        fromText = 'From: ' + from.replace(/<(.*)>/, '').trim() +
        ' <' + data.config.fromEmail + '>';
      } else {
        fromText = 'From: ' + from.replace('<', 'at ').replace('>', '') +
        ' <' + data.originalRecipient + '>';
      }
      return fromText;
    });

  // Add a prefix to the Subject
  if (data.config.subjectPrefix) {
    header = header.replace(
      /^subject:[\t ]?(.*)/mgi,
      function(match, subject) {
        return 'Subject: ' + data.config.subjectPrefix + subject;
      });
  }

  // Replace original 'To' header with a manually defined one
  if (data.config.toEmail) {
    header = header.replace(/^to:[\t ]?(.*)/mgi, 'To: ' + data.config.toEmail);
  }

  // Remove the Return-Path header.
  header = header.replace(/^return-path:[\t ]?(.*)\r?\n/mgi, '');

  // Remove Sender header.
  header = header.replace(/^sender:[\t ]?(.*)\r?\n/mgi, '');

  // Remove Message-ID header.
  header = header.replace(/^message-id:[\t ]?(.*)\r?\n/mgi, '');

  // Remove all DKIM-Signature headers to prevent triggering an
  // "InvalidParameterValue: Duplicate header 'DKIM-Signature'" error.
  // These signatures will likely be invalid anyways, since the From
  // header was modified.
  header = header.replace(/^dkim-signature:[\t ]?.*\r?\n(\s+.*\r?\n)*/mgi, '');

  data.emailData = header + body;
  return data;
};

/**
 * Send email using the SESv2 SendEmailCommand command.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
async function sendMessage(data) {
  let params = {
    Destination: { ToAddresses: data.recipients },
    Source: data.originalRecipient,
    Content: { Raw: { Data: Buffer.from(data.emailData) } },
  };
  data.log({
    level: "info",
    message: "sendMessage: Sending email via SES. Original recipients: " +
      data.originalRecipients.join(", ") + ". Transformed recipients: " +
      data.recipients.join(", ") + "."
  });
  try {
    const result = await ses.send(new SendEmailCommand(params));
    data.log({
      level: "info",
      message: "SendEmailCommand() successful.",
      result: result
    });
    return data;
  } catch (err) {
    data.log({
      level: "error",
      message: "SendEmailCommand() returned error.",
      error: err,
      stack: err.stack
    });
    throw new Error('Error: Email sending failed.');
  }
};

/**
 * Handler function to be invoked by AWS Lambda with an inbound SES email as
 * the event.
 *
 * @param {object} event - Lambda event from inbound email received by AWS SES.
 * @param {object} context - Lambda context object.
 * @param {object} overrides - Overrides for the default data, including the
 * configuration, SES object, and S3 object.
 */
export default async function handler(event, context, overrides) {
  const data = {
    event: event,
    context: context,
    config: overrides && overrides.config ? overrides.config : defaultConfig,
    log: overrides && overrides.log ? overrides.log : console.log,
  };
  try {
    parseEvent(data);
    transformRecipients(data);
    await fetchMessage(data);
    processMessage(data);
    await sendMessage(data);
    data.log({
      level: "info",
      message: "Process finished successfully."
    });
  } catch (err) {
    data.log({
      level: "error",
      message: "Step returned error: " + err.message,
      error: err,
      stack: err.stack
    });
    throw new Error("Error: Step returned error.");
  }
};

