export async function retryAsyncOperation<T>(
  operation: () => Promise<T>,
  options: {
    retries: number;
    delayMs: number;
  }
): Promise<T> {
  const { retries, delayMs } = options;
  let attempt: number = 0;
  while (attempt < retries) {
    try {
      return await operation();
    } catch (error: unknown) {
      handleRetryError(error, attempt, retries);
      attempt++;
      try {
        await delay(delayMs);
      } catch (e) {
        throw new Error(`Delay failed at attempt ${attempt}: ${e instanceof Error ? e.message : 'Unknown error'}`);
      }
    }
  }
  throw new Error(`Unhandled retry failure after ${retries} attempts`);
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ms < 0) {
      reject(new Error('Delay duration must be non-negative'));
    }
    setTimeout(resolve, ms);
  });
}

function handleRetryError(error: unknown, attempt: number, retries: number): void {
  if (attempt === retries - 1) {
    let errorMessage = 'Unknown error';
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'string') {
      errorMessage = error;
    }
    throw new Error(`Operation failed after ${retries} attempts: ${errorMessage}`);
  }
}
