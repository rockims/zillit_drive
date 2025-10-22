# Zillit Drive File Sharing - Frontend Implementation Guide

## 📋 Overview

This guide provides comprehensive API documentation for implementing file sharing functionality in your frontend application. The system allows users to share files publicly with configurable permissions and expiration dates.

## ⏰ **Important: Epoch Timestamps**

**All date/time fields use epoch timestamps in milliseconds**, not ISO strings. This provides:
- ✅ Better performance (no string parsing)
- ✅ Easier calculations in JavaScript
- ✅ Database efficiency
- ✅ Timezone independence

**Example:**
```javascript
// ❌ DON'T use ISO strings
"expires_at": "2025-12-31T23:59:59Z"

// ✅ DO use epoch timestamps (milliseconds)
"expires_at": 1735689599000

// JavaScript helpers:
Date.now()                    // Current time
Date.now() + (24 * 60 * 60 * 1000)  // 24 hours from now
new Date(timestamp).toISOString()    // Convert to readable format
```

## 🔐 Authentication

All authenticated endpoints require the `moduledata` header:

```
Headers:
  moduledata: YOUR_AUTH_TOKEN
  Content-Type: application/json
```

## 🚀 Complete API Reference

### 1. Health Check

**Endpoint:** `GET /`
**Authentication:** None required
**Purpose:** Verify server status

**Response:**
```json
{
  "status": 1,
  "message": "server_running",
  "data": {
    "server": "Zillit Drive API",
    "version": "2.0",
    "timestamp": 1697625600000
  }
}
```

---

### 2. List Files

**Endpoint:** `GET /api/v2/drive/files`
**Authentication:** Required
**Purpose:** Get list of all files in user's drive

**Headers:**
```
moduledata: YOUR_AUTH_TOKEN
```

**Response:**
```json
{
  "status": 1,
  "message": "files_fetched",
  "data": [
    {
      "_id": "68f0cb8bdcbea8318fcaafb6",
      "file_name": "project_report.pdf",
      "file_type": "pdf",
      "file_size": "2.5MB",
      "created_on": 1760611211350
    }
  ]
}
```

---

### 3. Get File Details

**Endpoint:** `GET /api/v2/drive/files/{fileId}`
**Authentication:** Required
**Purpose:** Get detailed information about a specific file

**Parameters:**
- `fileId` (string): The file's MongoDB ObjectId

**Headers:**
```
moduledata: YOUR_AUTH_TOKEN
```

**Response:**
```json
{
  "status": 1,
  "message": "file_fetched",
  "data": {
    "_id": "68f0cb8bdcbea8318fcaafb6",
    "file_name": "project_report.pdf",
    "file_type": "pdf",
    "file_extension": "pdf",
    "file_size": "2.5MB",
    "file_size_bytes": 2621440,
    "mime_type": "application/pdf",
    "attachments": [
      {
        "media": "https://s3.amazonaws.com/bucket/file.pdf",
        "bucket": "zillit-drive-files",
        "region": "us-east-1"
      }
    ]
  }
}
```

---

### 4. Create File Share ⭐

**Endpoint:** `POST /api/v2/drive/files/{fileId}/share`
**Authentication:** Required
**Purpose:** Create a public share link for a file

**Parameters:**
- `fileId` (string): The file's MongoDB ObjectId

**Headers:**
```
moduledata: YOUR_AUTH_TOKEN
Content-Type: application/json
```

**Request Body:**
```json
{
  "permissions": "read",  // "read" or "download"
  "expires_at": 1735689599000  // Optional: epoch timestamp in milliseconds
}
```

**Permissions Options:**
- `"read"`: View-only access
- `"download"`: View and download access

**Expiration Examples:**
```javascript
// 1 hour from now
"expires_at": Date.now() + (60 * 60 * 1000)

// 24 hours from now  
"expires_at": Date.now() + (24 * 60 * 60 * 1000)

// 7 days from now
"expires_at": Date.now() + (7 * 24 * 60 * 60 * 1000)

// 30 days from now
"expires_at": Date.now() + (30 * 24 * 60 * 60 * 1000)

// No expiration (permanent)
// Omit expires_at field entirely or set to null
```

**Response:**
```json
{
  "status": 1,
  "message": "file_shared",
  "data": {
    "share_token": "b9dea84c50a83729f9d5bf5b0b74f3503303fd6f9b205d7dbd7b75960580c893",
    "share_url": "http://localhost:8105/api/v2/drive/public/b9dea84c...",
    "permissions": "read",
    "expires_at": 1735689599000,
    "created_at": 1760786956279
  }
}
```

---

### 5. List File Shares

**Endpoint:** `GET /api/v2/drive/files/{fileId}/shares`
**Authentication:** Required
**Purpose:** Get all active shares for a specific file

**Parameters:**
- `fileId` (string): The file's MongoDB ObjectId

**Headers:**
```
moduledata: YOUR_AUTH_TOKEN
```

**Response:**
```json
{
  "status": 1,
  "message": "shares_fetched",
  "data": [
    {
      "_id": "share_id_1",
      "share_token": "b9dea84c50a83729f9d5bf5b0b74f3503303fd6f9b205d7dbd7b75960580c893",
      "permissions": "read",
      "expires_at": 1735689599000,
      "created_on": 1760786956043,
      "is_active": true
    }
  ]
}
```

---

### 6. Revoke File Shares

**Endpoint:** `DELETE /api/v2/drive/files/{fileId}/share`
**Authentication:** Required
**Purpose:** Revoke all active shares for a file

**Parameters:**
- `fileId` (string): The file's MongoDB ObjectId

**Headers:**
```
moduledata: YOUR_AUTH_TOKEN
```

**Response:**
```json
{
  "status": 1,
  "message": "shares_revoked",
  "data": {
    "revoked_count": 2,
    "file_id": "68f0cb8bdcbea8318fcaafb6"
  }
}
```

---

### 7. Access Public File (Metadata) ⭐

**Endpoint:** `GET /api/v2/drive/public/{shareToken}`
**Authentication:** None required
**Purpose:** Get file metadata and access URLs using share token

**Parameters:**
- `shareToken` (string): The share token from step 4

**Response:**
```json
{
  "status": 1,
  "message": "public_file_accessed",
  "data": {
    "_id": "68f0cb8bdcbea8318fcaafb6",
    "file_name": "project_report.pdf",
    "file_type": "pdf",
    "file_extension": "pdf",
    "file_size": "2.5MB",
    "permissions": "read",
    "shared_at": 1760786956043,
    "expires_at": 1735689599000,
    "signed_url": "https://s3.amazonaws.com/bucket/file.pdf",
    "download_url": null,
    "content_stream_url": "http://localhost:8105/api/v2/drive/public/{token}/content",
    "file_access_method": "direct_url",
    "access_info": {
      "has_s3_access": false,
      "has_direct_url": true,
      "has_content_stream": true,
      "attachment_count": 1
    }
  }
}
```

**Key Response Fields:**
- `signed_url`: Direct S3 URL (if available)
- `download_url`: S3 download URL (for download permissions)
- `content_stream_url`: **Always available** - server-proxied file access
- `file_access_method`: How file can be accessed
- `access_info`: Detailed access capabilities

---

### 8. Access Public File (Content) ⭐

**Endpoint:** `GET /api/v2/drive/public/{shareToken}/content`
**Authentication:** None required
**Purpose:** Download/stream the actual file content

**Parameters:**
- `shareToken` (string): The share token from step 4

**Response:** Raw file content with proper headers
```
Content-Type: application/pdf
Content-Length: 605
Content-Disposition: inline; filename="project_report.pdf"
Cache-Control: private, max-age=3600

[File content as binary stream]
```

---

## 🔄 Implementation Flow

### For File Owners (Creating Shares):

1. **List Files** → Get available files
2. **Create Share** → Generate public link with expiration
3. **Share URL** → Provide link to recipients
4. **Manage Shares** → List/revoke as needed

### For File Recipients (Accessing Shares):

1. **Access Metadata** → Get file info and access URLs
2. **Access Content** → Download/view the actual file
3. **Check Expiration** → Handle expired shares gracefully

## 🎯 Frontend Implementation Examples

### Creating a Share with Different Durations

```javascript
// Duration helper functions (epoch timestamps)
const getDuration = {
  oneHour: () => Date.now() + (60 * 60 * 1000),
  oneDay: () => Date.now() + (24 * 60 * 60 * 1000),
  oneWeek: () => Date.now() + (7 * 24 * 60 * 60 * 1000),
  oneMonth: () => Date.now() + (30 * 24 * 60 * 60 * 1000),
  permanent: () => null // No expiration
};

// API call examples
const createShare = async (fileId, duration, permission) => {
  const body = {
    permissions: permission // "read" or "download"
  };
  
  if (duration !== 'permanent') {
    body.expires_at = getDuration[duration]();
  }
  
  const response = await fetch(`/api/v2/drive/files/${fileId}/share`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'moduledata': YOUR_AUTH_TOKEN
    },
    body: JSON.stringify(body)
  });
  
  return response.json();
};
```

### Accessing Shared Files

```javascript
// Get file metadata and access options
const getSharedFile = async (shareToken) => {
  const response = await fetch(`/api/v2/drive/public/${shareToken}`);
  return response.json();
};

// Access file content
const downloadFile = async (shareToken) => {
  const response = await fetch(`/api/v2/drive/public/${shareToken}/content`);
  
  if (response.ok) {
    // For download
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    
    // Trigger download
    const a = document.createElement('a');
    a.href = url;
    a.download = response.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] || 'file';
    a.click();
    
    window.URL.revokeObjectURL(url);
  }
};

// For preview/display
const previewFile = (shareToken) => {
  // Direct link to content endpoint
  return `/api/v2/drive/public/${shareToken}/content`;
};
```

## ⚠️ Error Handling

### Common Error Responses:

**Share Not Found/Expired:**
```json
{
  "status": 0,
  "message": "share_not_found_or_expired"
}
```

**Share Expired:**
```json
{
  "status": 0,
  "message": "share_expired"
}
```

**File Not Found:**
```json
{
  "status": 0,
  "message": "file_not_found"
}
```

**Unauthorized:**
```json
{
  "status": 0,
  "message": "unauthorized"
}
```

## 🔒 Security Considerations

1. **Share Tokens**: Are cryptographically secure and unpredictable
2. **Expiration**: Always check expiration dates on the frontend
3. **Permissions**: Respect read vs download permissions
4. **HTTPS**: Use HTTPS in production for secure token transmission
5. **Rate Limiting**: Implement rate limiting for share creation
6. **Audit**: Log share access for security monitoring

## 🎨 UI/UX Recommendations

### Share Creation Interface:
- **Duration Dropdown**: 1 hour, 1 day, 1 week, 1 month, permanent
- **Permission Toggle**: Read-only vs Download
- **Copy Link Button**: Easy sharing
- **Expiration Display**: Clear expiration time
- **Revoke Button**: Easy share management

### File Access Interface:
- **File Preview**: Use content_stream_url for preview
- **Download Button**: Direct download functionality
- **Expiration Warning**: Show when share expires
- **Error Messages**: Handle expired/invalid shares gracefully

## 📊 Analytics & Monitoring

Track these metrics for insights:
- Share creation frequency
- Access patterns by duration
- Most shared file types
- Expiration vs actual usage
- Geographic access patterns
- Error rates by endpoint

## 🚀 Production Deployment

### Environment Variables:
```bash
BASE_URL=https://your-domain.com
AWS_ACCESS_KEY_ID=your_aws_key
AWS_SECRET_ACCESS_KEY=your_aws_secret
MONGODB_URI=your_mongodb_connection
```

### CDN Integration:
- Use CDN for file content delivery
- Cache static assets
- Implement geographic distribution
- Monitor bandwidth usage

## 📱 Mobile Considerations

- **Deep Links**: Support share URLs in mobile apps
- **Offline Caching**: Cache accessed files for offline viewing
- **Progressive Download**: For large files
- **Share Intent**: Native sharing integration
- **Biometric Security**: Optional security for sensitive shares

---

## 📞 Support & Integration

For technical support or integration questions:
1. Check this documentation first
2. Test with the provided Postman collection
3. Review server logs for detailed error information
4. Contact the development team with specific use cases

The system is designed to be flexible and can accommodate various frontend frameworks and use cases while maintaining security and performance.
