// Error messages
export const ERROR_MESSAGES = {
  WRITE_FILE_FAILURE: (filePath: string, errorMessage: string) => 
    `Failed to write to file ${filePath}: ${errorMessage}`,
  READ_FILE_FAILURE: (filePath: string, errorMessage: string) => 
    `Failed to read from file ${filePath}: ${errorMessage}`,
};

// Example API URLs
export const API_URLS = {
  BASE_URL: 'https://api.example.com',
  GET_USER: '/user',
  UPDATE_USER: '/user/update',
};
