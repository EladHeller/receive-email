import {Capability, CloudFormation, waitUntilStackCreateComplete, waitUntilStackUpdateComplete} from '@aws-sdk/client-cloudformation';
import fs from 'fs/promises';
const domainName = process.env.DOMAIN_NAME;
const hostedZoneId = process.env.HOSTED_ZONE_ID;
const queueUrl = process.env.SQS_QUEUE_URL;

const cf = new CloudFormation();

async function runTemplate(
    templatePath: string,
    name: string,
    parameters?: { ParameterKey: string; ParameterValue: string }[],
    capabilities?: Capability[],
  ): Promise<void> {
    let stack;
    try {
        stack = await cf.describeStacks({
            StackName: name,
        });
    } catch (e) {
        if (e.message.includes('does not exist')) {
            stack = { Stacks: [] };
        } else {
            throw e;
        }
    }
    const template = await fs.readFile(templatePath, 'utf-8');
    const newStack = stack.Stacks != null && stack.Stacks.length < 1;
    if (newStack) {
      await cf.createStack({
        StackName: name,
        TemplateBody: template,
        Capabilities: capabilities ?? [] satisfies Capability[],
        Parameters: parameters,
      });
    } else {
      try {
        await cf.updateStack({
          StackName: name,
          TemplateBody: template,
          Capabilities: capabilities,
          Parameters: parameters,
        });
      } catch (e) {
        if (e.message === 'No updates are to be performed.') {
          console.log(`template ${name} No updates are to be performed.`);
          return;
        }
        throw e;
      }
    }
  
    const { state, reason } = await Promise.race([
      waitUntilStackCreateComplete({ client: cf, maxWaitTime: 1000 * 60 * 30 }, { StackName: name }),
      waitUntilStackUpdateComplete({ client: cf, maxWaitTime: 1000 * 60 * 30 }, { StackName: name }),
    ]);
    if (['ABORTED', 'FAILURE', 'TIMEOUT'].includes(state)) {
      console.log(state, reason);
      throw new Error('Creation failed');
    }
    console.log(`template ${name} ${newStack ? 'created' : 'updated'}.`);
  }

async function main() {
  if (!domainName || !hostedZoneId || !queueUrl) {
    throw new Error('Missing environment variables');
  }
  await runTemplate('cf.template.yaml', 'EmailReceiveStack', [
          {
              ParameterKey: 'DomainName',
              ParameterValue: domainName
          },
          {
              ParameterKey: 'HostedZoneId',
              ParameterValue: hostedZoneId
          },
          {
              ParameterKey: 'SqsQueueUrl',
              ParameterValue: queueUrl
          }
      ],
      ['CAPABILITY_NAMED_IAM']
  );
}

main().catch(console.error);