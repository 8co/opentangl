import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface WebhookPayload {
  event: 'task.completed' | 'task.failed' | 'batch.completed';
  taskId: string | undefined;
  status: string;
  message: string;
  timestamp: string;
  metadata: Record<string, unknown> | undefined;
}

export async function sendWebhook(url: string, payload: WebhookPayload): Promise<{ success: boolean, statusCode: number | undefined }> {
  const isHttps = url.startsWith('https');
  const { request } = isHttps ? { request: httpsRequest } : { request: httpRequest };

  return new Promise((resolve) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    };

    const req = request(options, (res) => {
      const success = res.statusCode ? res.statusCode >= 200 && res.statusCode < 300 : false;
      resolve({ success, statusCode: res.statusCode });
    });

    req.on('error', () => {
      resolve({ success: false, statusCode: undefined });
    });

    req.write(JSON.stringify(payload));
    req.end();
  });
}

export function createTaskCompletedPayload(taskId: string, branch: string, durationMs: number): WebhookPayload {
  return {
    event: 'task.completed',
    taskId,
    status: 'completed',
    message: `Task ${taskId} completed successfully.`,
    timestamp: new Date().toISOString(),
    metadata: {
      branch,
      durationMs,
    },
  };
}

export function createTaskFailedPayload(taskId: string, error: string): WebhookPayload {
  return {
    event: 'task.failed',
    taskId,
    status: 'failed',
    message: `Task ${taskId} failed with error: ${error}`,
    timestamp: new Date().toISOString(),
    metadata: {
      error,
    },
  };
}
