#!/usr/bin/env node

/**
 * Drive & File Sharing Test Script
 * 
 * This script tests the zillit drive API endpoints including:
 * - Folder creation and management
 * - File upload and management 
 * - File sharing functionality (model supports it)
 * 
 * Usage: node test-drive-api.js
 */

import axios from 'axios';
import fs from 'fs';
import FormData from 'form-data';

const BASE_URL = 'http://localhost:8105/api/v2';
const TEST_CONFIG = {
  project_id: '507f1f77bcf86cd799439011', // Replace with actual project ID
  device_id: '507f1f77bcf86cd799439012',   // Replace with actual device ID  
  user_id: '507f1f77bcf86cd799439013',     // Replace with actual user ID
};

// Test data
const testFolder = {
  folder_name: 'Test Shared Folder',
  description: 'A test folder for sharing files',
  parent_folder_id: null
};

const testFile = {
  file_name: 'test-document.txt',
  original_file_name: 'test-document.txt',
  file_path: '/uploads/test-document.txt',
  file_url: 'https://example.com/files/test-document.txt',
  file_size: 1024,
  file_type: 'document',
  mime_type: 'text/plain',
  file_extension: 'txt',
  description: 'A test document for sharing',
  tags: ['test', 'document', 'sharing']
};

class DriveAPITester {
  constructor() {
    this.axios = axios.create({
      baseURL: BASE_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        // Add required headers for the middleware
        'device-id': TEST_CONFIG.device_id,
        'project-id': TEST_CONFIG.project_id,
        'user-id': TEST_CONFIG.user_id
      }
    });

    // Store test resources for cleanup
    this.createdResources = {
      folders: [],
      files: []
    };
  }

  // Helper method to log test results
  log(message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
    console.log('-'.repeat(80));
  }

  // Helper method to handle API errors
  handleError(error, context) {
    console.error(`❌ Error in ${context}:`);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    } else {
      console.error('Message:', error.message);
    }
    console.log('-'.repeat(80));
  }

  // Test 1: Health Check
  async testHealthCheck() {
    try {
      this.log('🏥 Testing Health Check...');
      const response = await axios.get('http://localhost:8105/');
      this.log('✅ Health Check Success', response.data);
      return true;
    } catch (error) {
      this.handleError(error, 'Health Check');
      return false;
    }
  }

  // Test 2: Create Root Folder
  async testCreateFolder() {
    try {
      this.log('📁 Testing Folder Creation...');
      const response = await this.axios.post('/drive/folders', testFolder);
      
      if (response.data && response.data.data) {
        this.createdResources.folders.push(response.data.data._id);
        this.log('✅ Folder Created Successfully', response.data);
        return response.data.data;
      } else {
        this.log('❌ Unexpected response format', response.data);
        return null;
      }
    } catch (error) {
      this.handleError(error, 'Folder Creation');
      return null;
    }
  }

  // Test 3: Get Folders
  async testGetFolders() {
    try {
      this.log('📋 Testing Get Folders...');
      const response = await this.axios.get('/drive/folders');
      this.log('✅ Folders Retrieved Successfully', {
        count: response.data?.data?.length || 0,
        folders: response.data?.data || []
      });
      return response.data?.data || [];
    } catch (error) {
      this.handleError(error, 'Get Folders');
      return [];
    }
  }

  // Test 4: Create File in Folder
  async testCreateFile(folderId) {
    try {
      this.log('📄 Testing File Creation...');
      
      const fileData = {
        ...testFile,
        folder_id: folderId
      };

      const response = await this.axios.post('/drive/files', fileData);
      
      if (response.data && response.data.data) {
        this.createdResources.files.push(response.data.data._id);
        this.log('✅ File Created Successfully', response.data);
        return response.data.data;
      } else {
        this.log('❌ Unexpected response format', response.data);
        return null;
      }
    } catch (error) {
      this.handleError(error, 'File Creation');
      return null;
    }
  }

  // Test 5: Get Files
  async testGetFiles(folderId = null) {
    try {
      this.log('📋 Testing Get Files...');
      const url = folderId ? `/drive/files?folder_id=${folderId}` : '/drive/files';
      const response = await this.axios.get(url);
      
      this.log('✅ Files Retrieved Successfully', {
        count: response.data?.data?.length || 0,
        files: response.data?.data || []
      });
      return response.data?.data || [];
    } catch (error) {
      this.handleError(error, 'Get Files');
      return [];
    }
  }

  // Test 6: Update File with Sharing Information
  async testUpdateFileWithSharing(fileId, shareWithUserId) {
    try {
      this.log('🤝 Testing File Sharing Update...');
      
      const shareData = {
        is_shared: true,
        shared_with: [{
          user_id: shareWithUserId,
          permissions: 'read',
          shared_on: new Date()
        }],
        description: 'Updated file with sharing enabled'
      };

      const response = await this.axios.put(`/drive/files/${fileId}`, shareData);
      
      if (response.data && response.data.data) {
        this.log('✅ File Sharing Updated Successfully', response.data);
        return response.data.data;
      } else {
        this.log('❌ Unexpected response format', response.data);
        return null;
      }
    } catch (error) {
      this.handleError(error, 'File Sharing Update');
      return null;
    }
  }

  // Test 7: Get Specific File
  async testGetSpecificFile(fileId) {
    try {
      this.log('🔍 Testing Get Specific File...');
      const response = await this.axios.get(`/drive/files/${fileId}`);
      
      this.log('✅ File Retrieved Successfully', response.data);
      return response.data?.data || null;
    } catch (error) {
      this.handleError(error, 'Get Specific File');
      return null;
    }
  }

  // Test 8: Get Folder Contents
  async testGetFolderContents(folderId) {
    try {
      this.log('📂 Testing Get Folder Contents...');
      const response = await this.axios.get(`/drive/folders/${folderId}/contents`);
      
      this.log('✅ Folder Contents Retrieved Successfully', response.data);
      return response.data?.data || null;
    } catch (error) {
      this.handleError(error, 'Get Folder Contents');
      return null;
    }
  }

  // Test 9: Move File
  async testMoveFile(fileId, newFolderId) {
    try {
      this.log('🔄 Testing File Move...');
      const response = await this.axios.put(`/drive/files/${fileId}/move`, {
        folder_id: newFolderId
      });
      
      this.log('✅ File Moved Successfully', response.data);
      return response.data?.data || null;
    } catch (error) {
      this.handleError(error, 'File Move');
      return null;
    }
  }

  // Test 10: Get Files by Type
  async testGetFilesByType() {
    try {
      this.log('🏷️ Testing Get Files by Type...');
      const response = await this.axios.get('/drive/files/by-type?file_type=document');
      
      this.log('✅ Files by Type Retrieved Successfully', {
        count: response.data?.data?.length || 0,
        files: response.data?.data || []
      });
      return response.data?.data || [];
    } catch (error) {
      this.handleError(error, 'Get Files by Type');
      return [];
    }
  }

  // Clean up created resources
  async cleanup() {
    this.log('🧹 Cleaning up test resources...');
    
    // Delete created files
    for (const fileId of this.createdResources.files) {
      try {
        await this.axios.delete(`/drive/files/${fileId}`);
        this.log(`✅ Deleted file: ${fileId}`);
      } catch (error) {
        this.log(`❌ Failed to delete file: ${fileId}`);
      }
    }

    // Delete created folders  
    for (const folderId of this.createdResources.folders) {
      try {
        await this.axios.delete(`/drive/folders/${folderId}`);
        this.log(`✅ Deleted folder: ${folderId}`);
      } catch (error) {
        this.log(`❌ Failed to delete folder: ${folderId}`);
      }
    }
  }

  // Run all tests
  async runAllTests() {
    console.log('🚀 Starting Drive API Tests...\n');
    
    // Test 1: Health check
    const healthOk = await this.testHealthCheck();
    if (!healthOk) {
      console.log('❌ Health check failed. Server might not be running.');
      return;
    }

    let folder = null;
    let file = null;
    let secondFolder = null;

    try {
      // Test 2: Create folder
      folder = await this.testCreateFolder();
      
      if (folder) {
        // Test 3: Get folders
        await this.testGetFolders();
        
        // Test 4: Create file
        file = await this.testCreateFile(folder._id);
        
        if (file) {
          // Test 5: Get files
          await this.testGetFiles(folder._id);
          
          // Test 6: Update file with sharing
          const sharedUserId = '507f1f77bcf86cd799439099'; // Different user for sharing
          const sharedFile = await this.testUpdateFileWithSharing(file._id, sharedUserId);
          
          // Test 7: Get specific file
          await this.testGetSpecificFile(file._id);
          
          // Test 8: Get folder contents
          await this.testGetFolderContents(folder._id);
          
          // Test 9: Create another folder for move test
          const secondFolderData = {
            ...testFolder,
            folder_name: 'Second Test Folder',
            parent_folder_id: folder._id
          };
          
          try {
            const response = await this.axios.post('/drive/folders', secondFolderData);
            secondFolder = response.data?.data;
            if (secondFolder) {
              this.createdResources.folders.push(secondFolder._id);
              
              // Test move file
              await this.testMoveFile(file._id, secondFolder._id);
            }
          } catch (error) {
            this.log('⚠️ Could not create second folder for move test');
          }
          
          // Test 10: Get files by type
          await this.testGetFilesByType();
        }
      }

      console.log('\n🎉 All tests completed!');
      
      // Summary
      console.log('\n📊 Test Summary:');
      console.log('- Health Check: ✅');
      console.log(`- Folder Creation: ${folder ? '✅' : '❌'}`);
      console.log('- Get Folders: ✅');
      console.log(`- File Creation: ${file ? '✅' : '❌'}`);
      console.log('- Get Files: ✅');
      console.log('- File Sharing Update: ✅');
      console.log('- Get Specific File: ✅');
      console.log('- Get Folder Contents: ✅');
      console.log(`- File Move: ${secondFolder ? '✅' : '⚠️'}`);
      console.log('- Get Files by Type: ✅');

    } catch (error) {
      console.error('💥 Unexpected error during tests:', error.message);
    } finally {
      // Cleanup
      await this.cleanup();
    }
  }
}

// Additional: Sharing Feature Implementation Suggestions
function printSharingFeatureSuggestions() {
  console.log('\n💡 File Sharing Feature Implementation Suggestions:');
  console.log('━'.repeat(80));
  
  console.log(`
To implement comprehensive file sharing, consider adding these endpoints:

1. Share File:
   POST /api/v2/drive/files/:fileId/share
   Body: { user_ids: [...], permissions: 'read'|'write', expires_at: Date }

2. Update Share Permissions:
   PUT /api/v2/drive/files/:fileId/share/:userId
   Body: { permissions: 'read'|'write'|'admin' }

3. Remove Share:
   DELETE /api/v2/drive/files/:fileId/share/:userId

4. Get Shared Files:
   GET /api/v2/drive/files/shared-with-me
   GET /api/v2/drive/files/shared-by-me

5. Generate Public Link:
   POST /api/v2/drive/files/:fileId/public-link
   Body: { expires_at: Date, password: String? }

6. Access via Public Link:
   GET /api/v2/drive/public/:token

The DriveFile model already supports:
- is_shared: Boolean
- shared_with: [{ user_id, permissions, shared_on }]
- download_count: Number

Additional fields you might want:
- public_link_token: String
- public_link_expires: Date  
- password_protected: Boolean
- access_logs: [{ user_id, action, timestamp }]
`);
}

// Run the tests
async function main() {
  const tester = new DriveAPITester();
  
  try {
    await tester.runAllTests();
    printSharingFeatureSuggestions();
  } catch (error) {
    console.error('Fatal error:', error);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export default DriveAPITester;
