import {
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import crypto from "crypto";

export const post = async (event) => {
  const requestBody = JSON.parse(event.body);

  const item = {
    id: { S: crypto.randomUUID() },
    title: { S: requestBody.title },
  };

  const client = new DynamoDBClient({ region: "ap-northeast-1" });

  const command = new PutItemCommand({
    TableName: "tasks",
    Item: item,
  });

  await client.send(command);

  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Task created successfully" }),
  };
};

export const list = async (event) => {
  const client = new DynamoDBClient({ region: "ap-northeast-1" });

  const command = new ScanCommand({
    TableName: "tasks",
  });

  const response = await client.send(command);

  return {
    statusCode: 200,
    body: JSON.stringify(response.Items),
  };
};
