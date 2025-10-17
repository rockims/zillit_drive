# Zillit Drive API Testing Documentation

This repository contains comprehensive API testing resources for the Zillit Drive application, including both Drive Folder and Drive File management APIs.

## 📁 Files Included

1. **`Zillit_Drive_API_Collection.postman_collection.json`** - Complete Postman collection
2. **`API_CURL_Commands.md`** - Detailed curl commands with examples and responses
3. **`test_drive_apis.sh`** - Automated testing script
4. **`README.md`** - This documentation file

## 🚀 Quick Start

### Prerequisites

- Node.js application running (default: `http://localhost:8105`)
- Valid access token for authentication
- `curl` and `jq` installed for testing script

### 1. Using Postman Collection

1. Open Postman
2. Click **Import** → **File** → Upload `Zillit_Drive_API_Collection.postman_collection.json`
3. Update collection variables:
   - `baseUrl`: Your API base URL (e.g., `http://localhost:8105`)
   - `access_token`: Your valid JWT/Bearer token
   - `device_id`: Your device identifier
   - `project_id`: Valid MongoDB ObjectId for project
   - `user_id`: Valid MongoDB ObjectId for user

### 2. Using Automated Testing Script

```bash
# Set environment variables
export BASE_URL="http://localhost:8105"
export ACCESS_TOKEN="your_actual_access_token_here"
export DEVICE_ID="your_device_id"
export PROJECT_ID="507f1f77bcf86cd799439011"  # Valid ObjectId
export USER_ID="507f1f77bcf86cd799439022"     # Valid ObjectId

# Run the test script
./test_drive_apis.sh
```

### 3. Using Individual Curl Commands

Refer to `API_CURL_Commands.md` for detailed curl examples with expected responses.

## 📋 API Endpoints Overview

### Drive Folder APIs

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v2/drive-folders/` | Create a new folder |
| GET | `/api/v2/drive-folders/` | Get all folders (with pagination) |
| GET | `/api/v2/drive-folders/{folderId}` | Get specific folder by ID |
| GET | `/api/v2/drive-folders/{folderId}/contents` | Get folder contents (subfolders + files) |
| PUT | `/api/v2/drive-folders/{folderId}` | Update folder information |
| DELETE | `/api/v2/drive-folders/{folderId}` | Delete folder |

### Drive File APIs

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v2/drive-files/` | Create/upload a new file |
| GET | `/api/v2/drive-files/` | Get all files (with filtering) |
| GET | `/api/v2/drive-files/by-type` | Get files filtered by type |
| GET | `/api/v2/drive-files/{fileId}` | Get specific file by ID |
| PUT | `/api/v2/drive-files/{fileId}` | Update file information |
| PUT | `/api/v2/drive-files/{fileId}/move` | Move file to different folder |
| DELETE | `/api/v2/drive-files/{fileId}` | Delete file |

## 🔧 Required Headers

All API requests must include these headers:

```
Authorization: Bearer {access_token}
device-id: {device_id}
project-id: {project_id}
user-id: {user_id}
Content-Type: application/json  (for POST/PUT requests)
```

## 📄 Request/Response Examples

### Create Folder Request
```json
{
  "folder_name": "My Documents",          // string, required - Name of the folder
  "parent_folder_id": null,               // string (ObjectId) or null, optional - Parent folder ID
  "description": "Main documents folder", // string, optional - Folder description
  "attachments": [                        // array, optional - Array of attachment objects
    {
      "media": "https://example.com/thumbnail.jpg",  // string, optional - Media URL
      "name": "folder_thumbnail",                     // string, optional - Attachment name
      "thumbnail": "https://example.com/thumb.jpg",  // string, optional - Thumbnail URL
      "content_type": "image",                        // string, optional - Content type (document/image/audio/video)
      "content_subtype": "jpeg",                      // string, optional - Content subtype
      "caption": "Folder thumbnail",                  // string, optional - Caption text
      "duration": 0,                                  // number, optional - Duration for media files
      "height": 150,                                  // number, optional - Height in pixels
      "width": 150,                                   // number, optional - Width in pixels
      "bucket": "zillit-bucket",                      // string, optional - S3 bucket name
      "region": "us-east-1",                          // string, optional - AWS region
      "created": 1697462400000,                       // number, optional - Creation timestamp
      "file_size": "2KB",                             // string, optional - Human readable file size
      "content_id": "content_123"                     // string, optional - Content identifier
    }
  ]
}
```

### Create File Request
```json
{
  "file_name": "project_report.pdf",                 // string, required - Name of the file
  "folder_id": "654321098765432109876543",           // string (ObjectId) or null, optional - Parent folder ID
  "file_path": "/documents/reports/",                // string, optional - File path/location
  "description": "Monthly project report",          // string, optional - File description
  "file_type": "pdf",                               // string, optional - File type/extension
  "file_size": "2.5MB",                             // string, optional - Human readable file size
  "file_size_bytes": 2621440,                       // number, optional - File size in bytes
  "mime_type": "application/pdf",                   // string, optional - MIME type
  "attachment": {                                   // object, optional - File attachment details
    "url": "https://s3.amazonaws.com/bucket/file.pdf",           // string, optional - File URL
    "bucket": "zillit-drive-files",                              // string, optional - S3 bucket name
    "key": "files/project_report_123.pdf",                      // string, optional - S3 object key
    "cdn_url": "https://cdn.zillit.com/files/project_report_123.pdf", // string, optional - CDN URL
    "original_name": "project_report.pdf",                      // string, optional - Original filename
    "size": 2621440,                                            // number, optional - File size in bytes
    "mime_type": "application/pdf",                              // string, optional - MIME type
    "encoding": "utf-8"                                          // string, optional - File encoding
  }
}
```

### Standard Success Response Format
```json
{
  "success": true,
  "message": "operation_completed",
  "data": {
    // Response data object
  }
}
```

### Standard Error Response Format
```json
{
  "success": false,
  "message": "error_code",
  "error": {
    "code": "ERROR_TYPE",
    "details": "Specific error description"
  }
}
```

## 🔍 Query Parameters

### Pagination (GET requests)


### Filtering
- **Folders**: `parent_folder_id` - Filter by parent folder
- **Files**: `folder_id`, `file_type` - Filter by folder or file type

### Example with filters:
```
GET /api/v2/drive/files/?folder_id=123&file_type=pdf
```

## 📊 HTTP Status Codes

- `200` - OK (Success)
- `201` - Created (Resource created successfully)
- `400` - Bad Request (Validation errors)
- `401` - Unauthorized (Authentication required)
- `404` - Not Found (Resource doesn't exist)
- `500` - Internal Server Error

## 🛠 Validation Rules

### Folder Creation/Update
- `folder_name`: **string, required** - Non-empty string, trimmed
- `parent_folder_id`: **string (ObjectId) or null, optional** - Valid MongoDB ObjectId or null for root folder
- `description`: **string, optional** - Can be empty string, folder description text
- `attachments`: **array, optional** - Array of attachment objects

#### Attachment Object Fields:
- `media`: **string, optional** - Media/file URL
- `name`: **string, optional** - Attachment name/identifier
- `thumbnail`: **string, optional** - Thumbnail image URL
- `content_type`: **string, optional** - Must be one of: `document`, `image`, `audio`, `video`
- `content_subtype`: **string, optional** - File format (e.g., `jpeg`, `pdf`, `mp4`)
- `caption`: **string, optional** - Display caption text
- `duration`: **number, optional** - Duration in seconds for audio/video files
- `height`: **number, optional** - Height in pixels for images/videos
- `width`: **number, optional** - Width in pixels for images/videos
- `bucket`: **string, optional** - S3 bucket name
- `region`: **string, optional** - AWS region
- `created`: **number, optional** - Creation timestamp (Unix timestamp)
- `file_size`: **string, optional** - Human-readable file size (e.g., "2KB", "1.5MB")
- `content_id`: **string, optional** - Unique content identifier

### File Creation/Update
- `file_name`: **string, required** - Non-empty string, trimmed, filename with extension
- `folder_id`: **string (ObjectId) or null, optional** - Valid MongoDB ObjectId or null for root
- `file_path`: **string, optional** - File path/location, can be empty
- `description`: **string, optional** - Can be empty string, file description
- `file_type`: **string, optional** - File type/extension (e.g., `pdf`, `jpg`, `docx`)
- `file_size`: **string, optional** - Human-readable file size (e.g., "2.5MB")
- `file_size_bytes`: **number, optional** - Exact file size in bytes
- `mime_type`: **string, optional** - MIME type (e.g., `application/pdf`, `image/jpeg`)
- `attachment`: **object, optional** - File attachment details object

#### File Attachment Object Fields:
- `url`: **string, optional** - Direct file URL, can be empty
- `bucket`: **string, optional** - S3 bucket name, can be empty
- `key`: **string, optional** - S3 object key/path, can be empty
- `cdn_url`: **string, optional** - CDN URL for faster access, can be empty
- `original_name`: **string, optional** - Original filename when uploaded, can be empty
- `size`: **number, optional** - File size in bytes
- `mime_type`: **string, optional** - MIME type, can be empty
- `encoding`: **string, optional** - File encoding (e.g., `utf-8`), can be empty

### File Move Operation
- `target_folder_id`: **string (ObjectId) or null, optional** - Destination folder ID or null for root

### Data Type Notes:
- **ObjectId**: 24-character hexadecimal string (MongoDB ObjectId format)
- **number**: Integer or decimal number
- **string**: Text value, can be empty unless specified as "non-empty"
- **array**: JSON array of objects or values
- **object**: JSON object with key-value pairs
- **null**: Explicitly null value (not undefined or empty string)

## 🧪 Testing Strategy

1. **Unit Testing**: Test individual endpoints with the curl commands
2. **Integration Testing**: Use the automated script to test complete workflows
3. **Postman Testing**: Use the collection for interactive testing and debugging

### Test Workflow Order:
1. Create folder
2. Create sub-folder
3. Create file in folder
4. Get folder contents
5. Move file between folders
6. Update folder/file information
7. Delete resources (cleanup)

## 🔐 Security Notes

- Always use HTTPS in production
- Keep access tokens secure and rotate regularly
- Validate all ObjectIds before sending requests
- Implement proper error handling in your applications

## 📝 Additional Notes

- All timestamps are in ISO 8601 format (UTC)
- ObjectIds follow MongoDB's 24-character hexadecimal format
- File attachments support S3 and CDN URLs
- All APIs return complete data without pagination
- Folder hierarchy supports unlimited nesting levels

## 🐛 Troubleshooting

### Common Issues:

1. **Invalid ObjectId**: Ensure all IDs are valid 24-character hex strings
2. **Authentication Failed**: Check if access token is valid and not expired
3. **Validation Errors**: Verify required fields are present and properly formatted
4. **Server Not Running**: Confirm the API server is running on the specified URL
5. **Network Issues**: Check connectivity and firewall settings

### Debug Tips:

- Use the automated script's colored output to quickly identify failures
- Check server logs for detailed error information
- Use Postman's console for request/response debugging
- Validate JSON payloads before sending requests

---

**Happy Testing! 🚀**

For questions or issues, please refer to the API documentation or contact the development team.