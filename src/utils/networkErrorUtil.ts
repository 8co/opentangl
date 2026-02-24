/**
 * Utility functions for handling network errors with enhanced type safety.
 */

// Defined type for network errors
export type NetworkError = {
  statusCode: number;
  message: string;
};

export type TimeoutError = {
  timeout: number;
  message: string;
};

export type NetworkErrorTypes = NetworkError | TimeoutError;

// Predicate function to check if an error is a network error
export const isNetworkError = (error: unknown): error is NetworkError => {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    'message' in error &&
    typeof (error as Record<string, unknown>)['statusCode'] === 'number' &&
    typeof (error as Record<string, unknown>)['message'] === 'string'
  );
};

// Predicate function to check if an error is a timeout error
export const isTimeoutError = (error: unknown): error is TimeoutError => {
  return (
    typeof error === 'object' &&
    error !== null &&
    'timeout' in error &&
    'message' in error &&
    typeof (error as Record<string, unknown>)['timeout'] === 'number' &&
    typeof (error as Record<string, unknown>)['message'] === 'string'
  );
};

// Predicate function to check if an error is of NetworkErrorTypes
export const isNetworkErrorType = (error: unknown): error is NetworkErrorTypes => {
  return isNetworkError(error) || isTimeoutError(error);
};

// Function to handle network errors by logging
export const handleNetworkError = (error: unknown): void => {
  if (isNetworkError(error)) {
    console.error(`Network Error: ${error.statusCode} - ${error.message}`);
  } else if (isTimeoutError(error)) {
    console.error(`Timeout Error: Waited ${error.timeout}ms - ${error.message}`);
  } else {
    console.error('Unknown error:', error);
  }
};

// Utility function for mapping error messages
export const mapErrorMessage = (message: string): string | undefined => {
  const errorMapping: Record<string, string> = {
    'Network Error': 'Network error occurred. Please check your connection and try again.',
    'timeout': 'Request timed out. Please try again later.',
    '401': 'Unauthorized: Invalid API key or permissions issue.',
    '403': 'Forbidden: You do not have permission to access this resource.',
    '404': 'Not found: The requested resource could not be found.',
    '500': 'Internal server error. Try again after some time.',
    '502': 'Bad Gateway: Invalid response from the upstream server.',
    '503': 'Service unavailable: OpenAI temporarily unavailable. Try again after some time.',
    '504': 'Gateway timeout: Upstream server failed to send a request in time.',
    '429': 'Too many requests: You have hit the rate limit. Try again later.',
    'Malformed response': 'Received a malformed response from OpenAI. Please try again later.'
  };
  
  for (const key in errorMapping) {
    if (message.includes(key)) {
      return errorMapping[key];
    }
  }
  return undefined;
};

// Utility function to generate error messages
export const generateErrorMessage = (err: unknown): string => {
  if (err instanceof Error) {
    return mapErrorMessage(err.message) || 'An unexpected error occurred. Please try again later.';
  }
  return 'An unknown error occurred.';
};

// Example function simulating a network operation that can produce errors
export const networkOperation = async (): Promise<void> => {
  try {
    // Simulate network request
    throw { statusCode: 404, message: 'Resource not found' };
  } catch (error) {
    handleNetworkError(error);
  }
};
