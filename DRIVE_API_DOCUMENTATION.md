# Zillit Drive API Documentation

## Overview
The Zillit Drive API provides endpoints for managing folders and files in a hierarchical structure. The API supports creating folders, uploading files (as folders with attachments), and organizing them within projects.

## Base URL
```
http://localhost:8105/api/v2
```

## Authentication
All requests require the `moduleData` header:
```
moduleData: 934a93cdef3e6aa550a1f18ed87db20e0298c982058539417f56919361658e7c440042945616eb953cf3d2a6a770099d61c21572941067951ccab89f96d8d6f171ffac1cf6441748d9079cf43be976a9a122acca46b7b3d4b2dab23f705e27a8f10aeb04a3a07cd94d7681c225f9dbf1d6bb281fd7ab4eec09b11985fecf47e32bff6b4ff7fc9fc4a7b1f57184d613e97cc9a9afbfb903fe64f50ec68a7d17f4d0ec09cc86d65ddd10dde1c0b47c249c654dc5af16b769ece7008efe56fa27652d259984135e1ec1316bb74fc0fb268a99ca60b31481b538af36db916b40e709
```

## Key Concepts

### Folder vs File Logic
- **Folder**: When `attachments` is empty or not provided, `is_folder = true`
- **File**: When `attachments` array has items, `is_folder = false`

### Data Model
```javascript
{
  "_id": "ObjectId",
  "project_id": "ObjectId", // Required
  "parent_folder_id": "ObjectId|null", // null for root level
  "folder_name": "string", // Required
  "folder_path": "string", // Auto-generated based on hierarchy
  "description": "string",
  "attachments": [AttachmentSchema], // Array of attachment objects
  "is_folder": "boolean", // Auto-determined based on attachments
  "created_by": "ObjectId",
  "updated_by": "ObjectId",
  "created_on": "timestamp",
  "updated_on": "timestamp",
  "deleted_on": "timestamp" // 0 for active items
}
```

### Attachment Schema
```javascript
{
  "media": "string", // URL or path to file
  "name": "string", // Display name
  "thumbnail": "string", // Thumbnail URL
  "content_type": "document|image|audio|video",
  "content_subtype": "string", // File extension
  "caption": "string",
  "duration": "number", // For media files
  "height": "number", // For images/videos
  "width": "number", // For images/videos
  "bucket": "string", // Storage bucket
  "region": "string", // Storage region
  "created": "timestamp",
  "file_size": "string",
  "content_id": "string"
}
```

## API Endpoints

### 1. Health Check
```http
GET /health
```
**Headers:**
- `moduleData`: Required

**Response:**
```json
{
  "success": true,
  "message": "Server is healthy"
}
```

### 2. Create Folder/File
```http
POST /drive/folders
```

**Headers:**
- `Content-Type: application/json`
- `moduleData`: Required

**Request Body (Folder):**
```json
{
  "folder_name": "My Documents",
  "description": "Personal documents folder",
  "parent_folder_id": null,
  "project_id": "507f1f77bcf86cd799439011"
}
```

**Request Body (File):**
```json
{
  "folder_name": "Document.pdf",
  "description": "Important PDF document",
  "parent_folder_id": "507f1f77bcf86cd799439011",
  "project_id": "507f1f77bcf86cd799439011",
  "attachments": [
    {
      "media": "https://example.com/document.pdf",
      "name": "Document.pdf",
      "content_type": "document",
      "content_subtype": "pdf",
      "file_size": "1024000",
      "bucket": "my-bucket",
      "region": "us-east-1"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "507f1f77bcf86cd799439012",
    "folder_name": "My Documents",
    "project_id": "507f1f77bcf86cd799439011",
    "parent_folder_id": null,
    "folder_path": "",
    "description": "Personal documents folder",
    "is_folder": true,
    "attachments": [],
    "created_on": 1697234567890,
    "updated_on": 1697234567890
  }
}
```

### 3. Get All Folders
```http
GET /drive/folders
```

**Query Parameters:**
- `parent_folder_id`: Filter by parent folder ID
- `root`: Set to "true" to get root level folders only

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "507f1f77bcf86cd799439012",
      "folder_name": "My Documents",
      "is_folder": true,
      "created_on": 1697234567890
    }
  ]
}
```

### 4. Get Folder by ID
```http
GET /drive/folders/:folderId
```

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "507f1f77bcf86cd799439012",
    "folder_name": "My Documents",
    "description": "Personal documents folder",
    "is_folder": true,
    "attachments": []
  }
}
```

### 5. Update Folder/File
```http
PUT /drive/folders/:folderId
```

**Request Body:**
```json
{
  "folder_name": "Updated Folder Name",
  "description": "Updated description",
  "attachments": []
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "507f1f77bcf86cd799439012",
    "folder_name": "Updated Folder Name",
    "description": "Updated description",
    "updated_on": 1697234567890
  }
}
```

### 6. Delete Folder/File
```http
DELETE /drive/folders/:folderId
```

**Response:**
```json
{
  "success": true,
  "message": "Folder deleted successfully"
}
```

## Error Responses

### Validation Errors
```json
{
  "success": false,
  "error": "folder_name_validation",
  "message": "Folder name is required"
}
```

### Business Logic Errors
```json
{
  "success": false,
  "error": "duplicate_folder_name",
  "message": "A folder with this name already exists"
}
```

```json
{
  "success": false,
  "error": "folder_not_empty",
  "message": "Cannot delete folder that contains files or subfolders"
}
```

## Usage Examples

### Creating a Folder Hierarchy
1. Create root folder: `parent_folder_id: null`
2. Create subfolder: `parent_folder_id: <root_folder_id>`
3. Upload file to subfolder: Include `attachments` array

### Converting Folder to File
Update a folder by adding attachments - this will automatically set `is_folder: false`

### File Organization
- Use `folder_path` to display full hierarchy
- Filter by `parent_folder_id` to get folder contents
- Check `is_folder` to distinguish between folders and files

## Testing
Use the provided test script:
```bash
./test_drive_api.sh
```

Or import the Postman collection: `Drive_API_Postman_Collection.json`
