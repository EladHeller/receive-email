const AWS = require('aws-sdk');
AWS.config.region = 'us-west-2';
const forward = require('./forward-mail')

exports.handler = function(event, context, callback) {
    var sesNotification = event.Records[0].ses;

    // Check if any spam check failed
    if (sesNotification.receipt.spfVerdict.status === 'FAIL'
            || sesNotification.receipt.dkimVerdict.status === 'FAIL'
            || sesNotification.receipt.spamVerdict.status === 'FAIL'
            || sesNotification.receipt.virusVerdict.status === 'FAIL') {
        console.log('Dropping spam');
        // Stop processing rule set, dropping message
        callback(null, {'disposition':'STOP_RULE_SET'});
    } else {
        forward.handler(event, context, callback)
    }
};