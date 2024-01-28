import fs from 'node:fs/promises';

import AdmZip from "adm-zip";
import { LambdaClient, GetFunctionCommand, UpdateFunctionCodeCommand, UpdateFunctionConfigurationCommand, DeleteAliasCommand } from '@aws-sdk/client-lambda';
import { SQSClient, CreateQueueCommand, ReceiveMessageCommand, SendMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";

const sqsClient = await time('new SQSClient', async () => new SQSClient({
    endpoint: 'http://localhost:4566',
    region: 'us-east-1',
    credentials: {
        accessKeyId: 'test',
        secretAccessKey: 'test',
    },
}));


async function time(title, fn) {
    console.log(title);
    const startMs = Date.now();
    const returnValue = await fn();
    const endMs = Date.now();
    const duration = (endMs - startMs) / 1000.0;
    console.log(`${duration} s`);

    return returnValue;
}


// Configure the AWS SDK to use the LocalStack endpoint and credentials
const lambdaClient = await time('new LambdaClient', async () => new LambdaClient({
    endpoint: 'http://localhost:4566',
    region: 'us-east-1',
    credentials: {
        accessKeyId: 'test',
        secretAccessKey: 'test',
    },
}));

async function downloadLambda(FunctionName) {

    const response = await time('GetFunctionCommand', async () => await lambdaClient.send(new GetFunctionCommand({ FunctionName })));

    // console.log(JSON.stringify(response, null, 2))




    const downloadDir = `./lambda/${FunctionName}`;
    const downloadZipPath = `${downloadDir}/${FunctionName}.zip`;

    await time(`rm ${downloadDir} && mkdir ${downloadDir}`, async () => {
        await fs.rm(downloadDir, { recursive: true, force: true });
        await fs.mkdir(downloadDir, { recursive: true });
    });


    const functionCode = await time(`GET ${response.Code.Location}`, async () => await fetch(response.Code.Location));

    await time(`save to ${downloadZipPath}`, async () => await fs.writeFile(downloadZipPath, functionCode.body));


    // reading archives
    const unzipPath = `${downloadDir}/unzip/`;
    await time(`unzip to ${unzipPath}`, async () => {
        var zip = new AdmZip(downloadZipPath);
        zip.extractAllTo(`${downloadDir}/unzip/`, true);
    });

    return { unzipPath };
}

async function createSQSQueue(FunctionName) {

    return await time('createSqsQueue', async () => {
        const QueueName = `local-node-lambda-debug-${FunctionName}`;
        const { QueueUrl } = await sqsClient.send(
            new CreateQueueCommand({
                QueueName,
                Attributes: {
                    ReceiveMessageWaitTimeSeconds: '20',
                }
            }),
        );
        return QueueUrl;
    });
}

import { fileURLToPath } from 'url';
import path from 'path';

function getDirname() {

    const filename = fileURLToPath(import.meta.url);
    return path.dirname(filename);
}


async function injectRelay(FunctionName, QueueUrl) {
    // creating archives
    const zip = new AdmZip();
    zip.addLocalFile(`${getDirname()}/relay.mjs`);
    // get everything as a buffer
    const ZipFile = zip.toBuffer();

    await time('UpdateFunctionConfigurationCommand', async () => {

        const response = await lambdaClient.send(new UpdateFunctionConfigurationCommand({
            FunctionName,
            Handler: 'relay.handler',
            Environment: {
                Variables: {
                    QueueUrl,
                }
            }
        }));
        console.log(JSON.stringify(response, null, 2));
    });

    await time('UpdateFunctionCodeCommand', async () => {
        await lambdaClient.send(new UpdateFunctionCodeCommand({
            FunctionName,
            ZipFile,
        }));
    });
}

async function pollForEvents(QueueUrl) {
    while (true) {
        const { Messages } = await sqsClient.send(new ReceiveMessageCommand({
            QueueUrl,
            WaitTimeSeconds: 20,
        }));
        if (!Messages) {
            continue;
        }

        for (const message of Messages) {
            if (!message.Body) {
                continue;
            }
            const body = JSON.parse(message.Body);

            if (!body.event) {
                continue;
            }

            console.log('incoming event', message.Body);

            await sqsClient.send(new DeleteAliasCommand({
                QueueUrl,
                ReceiptHandle: message.ReceiptHandle,
            }));

            await sqsClient.send(new SendMessageCommand({
                QueueUrl,
                MessageBody: {
                    awsRequestId: body.context.awsRequestId,
                    response: 'hello, world!'
                }
            }));
        }
    }
}
async function main() {
    const FunctionName = 'lambda_function_name';
    await downloadLambda(FunctionName);

    const QueueUrl = await createSQSQueue(FunctionName);

    await injectRelay(FunctionName, QueueUrl);

    await pollForEvents(QueueUrl);
}
await main();