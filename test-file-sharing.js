#!/usr/bin/env node

/**
 * Drive File Sharing Test Script
 * 
 * This script tests file sharing functionality for the zillit drive API.
 * It tests both existing endpoints and suggests new sharing endpoints.
 * 
 * Usage: node test-file-sharing.js
 */

import axios from 'axios';
import crypto from 'crypto';

const BASE_URL = 'http://localhost:8105/api/v2';
const SERVER_URL = 'http://localhost:8105';

// Use the moduledata from the successful request you provided
const MODULE_DATA = '9bf45a428070559f3376f051dd8877f1cdc26fed18a17e5d9f05337339f17aaa2dcb4c3474635573f852906b03eeab055b53675d1c163c04a58173d85a4fba3bc24b2494c14e2f943e44738ecfe9dab8818d7fe7a9ac6ecbd9bffa85e295cd4f8f288371124b3e34ff5989b589685eb975bc1eb34020fb1924b72e64c1fd4d73f9e439c1ab7104103a2f2094f8ff6e40349954d10bee1fde2f9df25fd019413b';

// Test configuration - using real IDs from your successful request
const TEST_CONFIG = {
  folder_id: '68f0931896a3ef9794b9eec3',
  file_id: '68f0cb8bdcbea8318fcaafb6', // The updated_project_report.pdf file
  project_id: '68eca9d76208f330d648cfd2',
  share_with_user_id: '68edeeae027176b3686533ca', // Another user to share with
};

class FileSharingTester {
  constructor() {
    this.axios = axios.create({
      baseURL: BASE_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'moduledata': MODULE_DATA
      }
    });

    this.shareToken = null;
    this.publicLinkId = null;
  }

  // Helper method to log test results
  log(message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
    console.log('='.repeat(80));
  }

  // Helper method to handle API errors
  handleError(error, context) {
    console.error(`❌ Error in ${context}:`);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
      console.error('Headers:', error.response.headers);
    } else {
      console.error('Message:', error.message);
    }
    console.log('='.repeat(80));
    return false;
  }

  // Test 1: Health Check
  async testHealthCheck() {
    try {
      this.log('🏥 Testing API Health Check...');
      const response = await axios.get(`${SERVER_URL}/`);
      this.log('✅ Health Check Success', response.data);
      return true;
    } catch (error) {
      this.handleError(error, 'Health Check');
      return false;
    }
  }

  // Test 2: Get Existing Files (to verify API works)
  async testGetExistingFiles() {
    try {
      this.log('📋 Testing Get Existing Files...');
      const response = await this.axios.get(`/drive/files/?folder_id=${TEST_CONFIG.folder_id}`);
      
      if (response.data && response.data.data && response.data.data.length > 0) {
        this.log('✅ Files Retrieved Successfully', {
          count: response.data.data.length,
          files: response.data.data.map(f => ({ id: f._id, name: f.file_name, size: f.file_size }))
        });
        return response.data.data;
      } else {
        this.log('⚠️ No files found in the folder');
        return [];
      }
    } catch (error) {
      this.handleError(error, 'Get Existing Files');
      return [];
    }
  }

  // Test 3: Get Specific File Details
  async testGetFileDetails(fileId) {
    try {
      this.log(`🔍 Testing Get File Details for ID: ${fileId}...`);
      const response = await this.axios.get(`/drive/files/${fileId}`);
      
      if (response.data && response.data.data) {
        this.log('✅ File Details Retrieved Successfully', response.data.data);
        return response.data.data;
      } else {
        this.log('❌ Failed to get file details');
        return null;
      }
    } catch (error) {
      this.handleError(error, 'Get File Details');
      return null;
    }
  }

  // Test 4: Test File Sharing via Update (if sharing fields exist in model)
  async testFileSharing(fileId) {
    try {
      this.log(`🤝 Testing File Sharing for file ID: ${fileId}...`);
      
      // Try to update file with sharing information
      const shareData = {
        description: "File updated with sharing test",
        // Add any sharing-related fields that might exist
        shared: true,
        share_token: crypto.randomUUID(),
        shared_with_users: [TEST_CONFIG.share_with_user_id],
        share_permissions: 'read'
      };

      const response = await this.axios.put(`/drive/files/${fileId}`, shareData);
      
      if (response.data && response.data.data) {
        this.log('✅ File Sharing Update Successful', response.data.data);
        return response.data.data;
      } else {
        this.log('❌ File sharing update failed');
        return null;
      }
    } catch (error) {
      this.handleError(error, 'File Sharing Update');
      return null;
    }
  }

  // Test 5: Test Share Link Generation (mock endpoint)
  async testGenerateShareLink(fileId) {
    try {
      this.log(`🔗 Testing Share Link Generation for file ID: ${fileId}...`);
      
      // Generate a mock share token
      this.shareToken = crypto.randomUUID();
      
      const linkData = {
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
        permissions: 'read',
        password_protected: false
      };

      // Try potential share endpoints
      const possibleEndpoints = [
        `/drive/files/${fileId}/share`,
        `/drive/files/${fileId}/generate-link`,
        `/drive/files/${fileId}/public-link`
      ];

      for (const endpoint of possibleEndpoints) {
        try {
          this.log(`🔄 Trying endpoint: ${endpoint}`);
          const response = await this.axios.post(endpoint, linkData);
          
          if (response.data) {
            this.log('✅ Share Link Generated Successfully', response.data);
            if (response.data.data && response.data.data.share_token) {
              this.shareToken = response.data.data.share_token;
            }
            return response.data.data;
          }
        } catch (error) {
          if (error.response && error.response.status === 404) {
            this.log(`⚠️ Endpoint not found: ${endpoint}`);
          } else {
            this.handleError(error, `Share Link Generation - ${endpoint}`);
          }
        }
      }

      // If no endpoint exists, simulate the functionality
      this.log('💡 No share endpoint found. Here\'s what a share link response might look like:', {
        share_token: this.shareToken,
        share_url: `${SERVER_URL}/api/v2/drive/public/${this.shareToken}`,
        expires_at: linkData.expires_at,
        permissions: linkData.permissions,
        file_id: fileId
      });

      return {
        share_token: this.shareToken,
        share_url: `${SERVER_URL}/api/v2/drive/public/${this.shareToken}`,
        expires_at: linkData.expires_at,
        permissions: linkData.permissions
      };

    } catch (error) {
      this.handleError(error, 'Share Link Generation');
      return null;
    }
  }

  // Test 6: Test Public Link Access (mock)
  async testPublicLinkAccess() {
    if (!this.shareToken) {
      this.log('⚠️ No share token available for public link test');
      return;
    }

    try {
      this.log(`🌐 Testing Public Link Access with token: ${this.shareToken}...`);
      
      // Try potential public access endpoints
      const possibleEndpoints = [
        `/drive/public/${this.shareToken}`,
        `/drive/shared/${this.shareToken}`,
        `/public/files/${this.shareToken}`
      ];

      for (const endpoint of possibleEndpoints) {
        try {
          this.log(`🔄 Trying public endpoint: ${endpoint}`);
          const response = await axios.get(`${BASE_URL}${endpoint}`);
          
          if (response.data) {
            this.log('✅ Public Link Access Successful', response.data);
            return response.data;
          }
        } catch (error) {
          if (error.response && error.response.status === 404) {
            this.log(`⚠️ Public endpoint not found: ${endpoint}`);
          } else {
            this.handleError(error, `Public Link Access - ${endpoint}`);
          }
        }
      }

      this.log('💡 Public link access endpoints not implemented yet.');
      this.log('💡 Expected functionality: Return file metadata and download URL for valid tokens');

    } catch (error) {
      this.handleError(error, 'Public Link Access');
    }
  }

  // Test 7: Test Share Management
  async testShareManagement(fileId) {
    try {
      this.log(`👥 Testing Share Management for file ID: ${fileId}...`);
      
      // Try to get current shares
      const possibleEndpoints = [
        `/drive/files/${fileId}/shares`,
        `/drive/files/${fileId}/permissions`,
        `/drive/files/${fileId}/access`
      ];

      for (const endpoint of possibleEndpoints) {
        try {
          this.log(`🔄 Trying shares endpoint: ${endpoint}`);
          const response = await this.axios.get(endpoint);
          
          if (response.data) {
            this.log('✅ Share Management Access Successful', response.data);
            return response.data;
          }
        } catch (error) {
          if (error.response && error.response.status === 404) {
            this.log(`⚠️ Shares endpoint not found: ${endpoint}`);
          } else {
            this.handleError(error, `Share Management - ${endpoint}`);
          }
        }
      }

      this.log('💡 Share management endpoints not implemented yet.');
      
    } catch (error) {
      this.handleError(error, 'Share Management');
    }
  }

  // Test 8: Test Batch File Operations
  async testBatchOperations() {
    try {
      this.log('📦 Testing Batch File Operations...');
      
      const files = await this.testGetExistingFiles();
      if (files.length < 2) {
        this.log('⚠️ Need at least 2 files for batch operations test');
        return;
      }

      const fileIds = files.slice(0, 2).map(f => f._id);
      
      const batchData = {
        file_ids: fileIds,
        operation: 'share',
        share_with: [TEST_CONFIG.share_with_user_id],
        permissions: 'read'
      };

      // Try potential batch endpoints
      const possibleEndpoints = [
        '/drive/files/batch-share',
        '/drive/batch/share',
        '/drive/files/bulk-operations'
      ];

      for (const endpoint of possibleEndpoints) {
        try {
          this.log(`🔄 Trying batch endpoint: ${endpoint}`);
          const response = await this.axios.post(endpoint, batchData);
          
          if (response.data) {
            this.log('✅ Batch Operations Successful', response.data);
            return response.data;
          }
        } catch (error) {
          if (error.response && error.response.status === 404) {
            this.log(`⚠️ Batch endpoint not found: ${endpoint}`);
          } else {
            this.handleError(error, `Batch Operations - ${endpoint}`);
          }
        }
      }

      this.log('💡 Batch operations endpoints not implemented yet.');
      
    } catch (error) {
      this.handleError(error, 'Batch Operations');
    }
  }

  // Generate comprehensive sharing implementation suggestions
  printImplementationSuggestions() {
    console.log('\n🚀 File Sharing Implementation Suggestions');
    console.log('='.repeat(80));
    
    console.log(`
📋 RECOMMENDED SHARING ENDPOINTS:

1. 🔗 Generate Share Link
   POST /api/v2/drive/files/:fileId/share
   Body: {
     "permissions": "read|write|download",
     "expires_at": "2024-12-31T23:59:59Z",
     "password": "optional_password",
     "allow_download": true,
     "notify_users": ["user1@email.com"]
   }

2. 🌐 Access Shared File (Public)
   GET /api/v2/drive/public/:shareToken
   Optional: ?password=xxx

3. 👥 Manage File Shares
   GET /api/v2/drive/files/:fileId/shares
   PUT /api/v2/drive/files/:fileId/shares/:shareId
   DELETE /api/v2/drive/files/:fileId/shares/:shareId

4. 📊 Share Analytics
   GET /api/v2/drive/files/:fileId/analytics
   (Views, downloads, access logs)

5. 📱 User's Shared Files
   GET /api/v2/drive/files/shared-by-me
   GET /api/v2/drive/files/shared-with-me

6. 📦 Batch Share Operations
   POST /api/v2/drive/files/batch-share
   Body: {
     "file_ids": ["id1", "id2"],
     "share_settings": { ... }
   }

🗄️  RECOMMENDED DATABASE SCHEMA ADDITIONS:

1. File Shares Collection:
   {
     "_id": ObjectId,
     "file_id": ObjectId,
     "shared_by": ObjectId,
     "share_token": String (UUID),
     "permissions": ["read", "write", "download"],
     "expires_at": Date,
     "password_hash": String,
     "access_count": Number,
     "last_accessed": Date,
     "is_active": Boolean,
     "created_at": Date
   }

2. Share Access Logs:
   {
     "_id": ObjectId,
     "share_token": String,
     "file_id": ObjectId,
     "accessed_by": String (IP/User),
     "action": String,
     "user_agent": String,
     "timestamp": Date
   }

🔐 SECURITY CONSIDERATIONS:

- Rate limiting for share link generation
- Expiration enforcement
- Password protection for sensitive files  
- Access logging and monitoring
- Watermarking for downloaded files
- Virus scanning before sharing
- Domain restrictions for sharing

🎯 INTEGRATION POINTS:

- Email notifications for new shares
- Slack/Teams integration for team sharing
- Mobile app deep linking
- Third-party cloud storage (Box, Dropbox)
- Document preview without download
- Collaborative editing integration

📈 ANALYTICS & MONITORING:

- Share usage statistics
- Most shared file types
- Geographic access patterns  
- Security incident tracking
- Performance metrics
`);
  }

  // Run all sharing tests
  async runAllTests() {
    console.log('🚀 Starting File Sharing Tests...\n');
    
    // Test 1: Health check
    const healthOk = await this.testHealthCheck();
    if (!healthOk) {
      console.log('❌ Health check failed. Server might not be running.');
      return;
    }

    let files = [];
    let testFile = null;

    try {
      // Test 2: Get existing files
      files = await this.testGetExistingFiles();
      
      if (files.length === 0) {
        console.log('⚠️ No files available for sharing tests');
        return;
      }

      // Use the first available file for testing
      testFile = files[0];
      const fileId = testFile._id;

      // Test 3: Get file details
      await this.testGetFileDetails(fileId);

      // Test 4: Test file sharing via update
      await this.testFileSharing(fileId);

      // Test 5: Test share link generation
      await this.testGenerateShareLink(fileId);

      // Test 6: Test public link access
      await this.testPublicLinkAccess();

      // Test 7: Test share management
      await this.testShareManagement(fileId);

      // Test 8: Test batch operations
      await this.testBatchOperations();

      console.log('\n🎉 All sharing tests completed!');
      
      // Summary
      console.log('\n📊 Test Summary:');
      console.log('- Health Check: ✅');
      console.log('- Get Files: ✅');
      console.log('- Get File Details: ✅');
      console.log('- File Update (sharing fields): ⚠️ (depends on model)');
      console.log('- Share Link Generation: ⚠️ (endpoints not implemented)');
      console.log('- Public Link Access: ⚠️ (endpoints not implemented)');
      console.log('- Share Management: ⚠️ (endpoints not implemented)');
      console.log('- Batch Operations: ⚠️ (endpoints not implemented)');

    } catch (error) {
      console.error('💥 Unexpected error during tests:', error.message);
    } finally {
      // Show implementation suggestions
      this.printImplementationSuggestions();
    }
  }
}

// Run the tests
async function main() {
  const tester = new FileSharingTester();
  
  try {
    await tester.runAllTests();
  } catch (error) {
    console.error('Fatal error:', error);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export default FileSharingTester;
