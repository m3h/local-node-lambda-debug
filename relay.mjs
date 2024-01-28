import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";

const QueueUrl = process.env.QueueUrl;

const sqsClient = new SQSClient({});

export const handler = async (event, context) => {
    await sqsClient.send(new SendMessageCommand({
        QueueUrl,
        MessageBody: {
            event,
            context,
        }
    }));

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
            if (body.awsRequestId !== context.awsRequestId) {
                continue;
            }

            await sqsClient.send(new DeleteMessageCommand({
                QueueUrl,
                ReceiptHandle: message.ReceiptHandle,
            }))
            return body.response;
        }
    }
};