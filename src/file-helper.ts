import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * Ensures the directory for the given file path exists, then writes the file with the specified content.
 *
 * @param fullPath - The full file path where the content should be written.
 * @param content - The content to write to the specified file.
 * @throws Will throw an error if the file cannot be written.
 */
export async function ensureDirectoryAndWriteFile(
  fullPath: string,
  content: string
): Promise<void> {
  validateStringInputs({ fullPath, content }, ['fullPath', 'content']);

  try {
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, { encoding: 'utf-8', flag: 'w' });
  } catch (error: unknown) {
    handleError(error, `Failed to write to file at path '${fullPath}'. Ensure the path is correct and you have write permissions.`);
  }
}

/**
 * Reads the content of a file from the specified path.
 *
 * @param filePath - The path of the file to read.
 * @returns The content of the file as a string, or null if the file cannot be read.
 */
export async function readFromFile(filePath: string): Promise<string | null> {
  validateStringInputs({ filePath }, ['filePath']);

  try {
    return await readFile(filePath, 'utf-8');
  } catch (error: unknown) {
    handleError(error, `Failed to read from file at path '${filePath}'. Check if the file exists and you have read permissions.`, true);
    return null;
  }
}

/**
 * Resolves a file path to an absolute path.
 *
 * @param baseDir - The base directory from which the file path should be resolved.
 * @param relativePath - The relative file path to resolve.
 * @returns The resolved absolute file path.
 */
export function resolveFilePath(baseDir: string, relativePath: string): string {
  validateStringInputs({ baseDir, relativePath }, ['baseDir', 'relativePath']);

  return resolve(baseDir, relativePath);
}

/**
 * Validates that the provided string values are not empty and throws an error if they are.
 *
 * @param inputs - An object containing input values to validate.
 * @param keys - The keys within the object to validate as non-empty strings.
 */
function validateStringInputs(inputs: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) {
    const value = inputs[key];
    if (typeof value !== 'string' || !value) {
      throw new Error(`Invalid argument: ${key} is required and must be a string.`);
    }
  }
}

/**
 * Handles the errors thrown by file operations, adds context and throws again if needed.
 *
 * @param error - The error object caught.
 * @param message - The custom message that offers more context about the error location.
 * @param suppressError - Determines if the error should be logged rather than thrown.
 */
function handleError(error: unknown, message: string, suppressError: boolean = false): void {
  const errorMessage: string = extractErrorMessage(error);

  const fullMessage = `${message}: ${errorMessage}`;
  
  logError(fullMessage, suppressError);
}

/**
 * Extracts the error message from the error object.
 *
 * @param error - The error object caught.
 * @returns The extracted error message.
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  } else if (typeof error === 'string') {
    return error;
  } else if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return 'Unknown error';
}

/**
 * Logs the error message and throws an error if it is not suppressed.
 *
 * @param message - The complete error message to log or throw.
 * @param suppressError - Determines if the error should be logged rather than thrown.
 */
function logError(message: string, suppressError: boolean): void {
  if (suppressError) {
    console.error(message);
  } else {
    throw new Error(message);
  }
}
