#!/bin/bash

# Zillit Drive API Testing Script
# This script tests all Drive Folder and Drive File APIs

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
BASE_URL="${BASE_URL:-http://localhost:8105}"
ACCESS_TOKEN="${ACCESS_TOKEN:-your_access_token_here}"
DEVICE_ID="${DEVICE_ID:-device_123}"
PROJECT_ID="${PROJECT_ID:-507f1f77bcf86cd799439011}"
USER_ID="${USER_ID:-507f1f77bcf86cd799439022}"

# Global variables for storing created IDs
FOLDER_ID=""
FILE_ID=""
SUB_FOLDER_ID=""

echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}    Zillit Drive API Testing Script${NC}"
echo -e "${BLUE}======================================${NC}"
echo ""
echo -e "${YELLOW}Configuration:${NC}"
echo "Base URL: $BASE_URL"
echo "Device ID: $DEVICE_ID"
echo "Project ID: $PROJECT_ID" 
echo "User ID: $USER_ID"
echo ""

# Function to make API calls
make_api_call() {
    local method=$1
    local endpoint=$2
    local data=$3
    local description=$4
    
    echo -e "${YELLOW}Testing: $description${NC}"
    echo "Endpoint: $method $endpoint"
    
    if [ -n "$data" ]; then
        response=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X $method \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "device-id: $DEVICE_ID" \
            -H "project-id: $PROJECT_ID" \
            -H "user-id: $USER_ID" \
            -d "$data" \
            "$BASE_URL$endpoint")
    else
        response=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X $method \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "device-id: $DEVICE_ID" \
            -H "project-id: $PROJECT_ID" \
            -H "user-id: $USER_ID" \
            "$BASE_URL$endpoint")
    fi
    
    # Extract HTTP status and body
    http_code=$(echo "$response" | tail -n1 | sed 's/.*HTTP_STATUS://')
    body=$(echo "$response" | sed '$d')
    
    # Check if request was successful
    if [[ $http_code -ge 200 && $http_code -lt 300 ]]; then
        echo -e "${GREEN}✓ Success (HTTP $http_code)${NC}"
        echo "$body" | jq '.' 2>/dev/null || echo "$body"
    else
        echo -e "${RED}✗ Failed (HTTP $http_code)${NC}"
        echo "$body" | jq '.' 2>/dev/null || echo "$body"
    fi
    
    echo ""
    return $http_code
}

# Function to extract ID from response
extract_id() {
    local response=$1
    echo "$response" | jq -r '.data._id' 2>/dev/null
}

echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}       DRIVE FOLDER API TESTS${NC}"
echo -e "${BLUE}======================================${NC}"
echo ""

# 1. Create Folder
folder_data='{
    "folder_name": "Test Documents",          // string, required - Name of the folder
    "parent_folder_id": null,                 // string (ObjectId) or null, optional - Parent folder ID
    "description": "Test folder for API testing", // string, optional - Folder description
    "attachments": [                          // array, optional - Array of attachment objects
        {
            "media": "https://example.com/thumbnail.jpg",  // string, optional - Media URL
            "name": "folder_thumbnail",                     // string, optional - Attachment name
            "content_type": "image",                        // string, optional - Content type (document/image/audio/video)
            "content_subtype": "jpeg",                      // string, optional - Content subtype
            "caption": "Test folder thumbnail",             // string, optional - Caption text
            "width": 150,                                   // number, optional - Width in pixels
            "height": 150,                                  // number, optional - Height in pixels
            "file_size": "2KB"                              // string, optional - Human readable file size
        }
    ]
}'

response=$(make_api_call "POST" "/api/v2/drive-folders/" "$folder_data" "Create Folder")
if [ $? -eq 201 ]; then
    FOLDER_ID=$(echo "$response" | grep -o '"_id":"[^"]*"' | cut -d'"' -f4 | head -1)
    echo -e "${GREEN}Created folder with ID: $FOLDER_ID${NC}"
    echo ""
fi

# 2. Get All Folders
make_api_call "GET" "/api/v2/drive/folders/" "" "Get All Folders"

# 3. Get Specific Folder (if folder was created)
if [ -n "$FOLDER_ID" ]; then
    make_api_call "GET" "/api/v2/drive-folders/$FOLDER_ID" "" "Get Specific Folder"
fi

# 4. Update Folder (if folder was created)
if [ -n "$FOLDER_ID" ]; then
    update_data='{
        "folder_name": "Updated Test Documents",        // string, optional - New folder name
        "description": "Updated test folder description" // string, optional - Updated description
    }'
    make_api_call "PUT" "/api/v2/drive-folders/$FOLDER_ID" "$update_data" "Update Folder"
fi

# 5. Create Sub-folder (if parent folder was created)
if [ -n "$FOLDER_ID" ]; then
    subfolder_data="{
        \"folder_name\": \"Sub Folder\",              // string, required - Name of the subfolder
        \"parent_folder_id\": \"$FOLDER_ID\",         // string (ObjectId), optional - Parent folder ID
        \"description\": \"Test sub folder\"          // string, optional - Subfolder description
    }"
    response=$(make_api_call "POST" "/api/v2/drive-folders/" "$subfolder_data" "Create Sub-Folder")
    if [ $? -eq 201 ]; then
        SUB_FOLDER_ID=$(echo "$response" | grep -o '"_id":"[^"]*"' | cut -d'"' -f4 | head -1)
        echo -e "${GREEN}Created sub-folder with ID: $SUB_FOLDER_ID${NC}"
        echo ""
    fi
fi

# 6. Get Folder Contents (if folder was created)
if [ -n "$FOLDER_ID" ]; then
    make_api_call "GET" "/api/v2/drive/folders/$FOLDER_ID/contents" "" "Get Folder Contents"
fi

echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}        DRIVE FILE API TESTS${NC}"
echo -e "${BLUE}======================================${NC}"
echo ""

# 1. Create File
file_data="{
    \"file_name\": \"test_document.pdf\",             // string, required - Name of the file
    \"folder_id\": \"$FOLDER_ID\",                    // string (ObjectId) or null, optional - Parent folder ID
    \"file_path\": \"/test/documents/\",              // string, optional - File path/location
    \"description\": \"Test PDF document\",          // string, optional - File description
    \"file_type\": \"pdf\",                          // string, optional - File type/extension
    \"file_size\": \"1.5MB\",                        // string, optional - Human readable file size
    \"file_size_bytes\": 1572864,                    // number, optional - File size in bytes
    \"mime_type\": \"application/pdf\",              // string, optional - MIME type
    \"attachment\": {                                // object, optional - File attachment details
        \"url\": \"https://s3.amazonaws.com/test-bucket/test_file.pdf\",     // string, optional - File URL
        \"bucket\": \"zillit-drive-test\",                                   // string, optional - S3 bucket name
        \"key\": \"files/test_document_123.pdf\",                           // string, optional - S3 object key
        \"cdn_url\": \"https://cdn.zillit.com/files/test_document_123.pdf\", // string, optional - CDN URL
        \"original_name\": \"test_document.pdf\",                           // string, optional - Original filename
        \"size\": 1572864,                                                  // number, optional - File size in bytes
        \"mime_type\": \"application/pdf\",                                  // string, optional - MIME type
        \"encoding\": \"utf-8\"                                              // string, optional - File encoding
    }
}"

response=$(make_api_call "POST" "/api/v2/drive-files/" "$file_data" "Create File")
if [ $? -eq 201 ]; then
    FILE_ID=$(echo "$response" | grep -o '"_id":"[^"]*"' | cut -d'"' -f4 | head -1)
    echo -e "${GREEN}Created file with ID: $FILE_ID${NC}"
    echo ""
fi

# 2. Get All Files
make_api_call "GET" "/api/v2/drive/files/" "" "Get All Files"

# 3. Get Files by Type
make_api_call "GET" "/api/v2/drive/files/by-type?file_type=pdf" "" "Get Files by Type (PDF)"

# 4. Get Files with Folder Filter (if folder was created)
if [ -n "$FOLDER_ID" ]; then
    make_api_call "GET" "/api/v2/drive/files/?folder_id=$FOLDER_ID" "" "Get Files by Folder"
fi

# 5. Get Specific File (if file was created)
if [ -n "$FILE_ID" ]; then
    make_api_call "GET" "/api/v2/drive-files/$FILE_ID" "" "Get Specific File"
fi

# 6. Update File (if file was created)
if [ -n "$FILE_ID" ]; then
    update_file_data='{
        "file_name": "updated_test_document.pdf",        // string, optional - Updated file name
        "description": "Updated test PDF document with new content" // string, optional - Updated description
    }'
    make_api_call "PUT" "/api/v2/drive-files/$FILE_ID" "$update_file_data" "Update File"
fi

# 7. Move File (if file and sub-folder were created)
if [ -n "$FILE_ID" ] && [ -n "$SUB_FOLDER_ID" ]; then
    move_data="{
        \"target_folder_id\": \"$SUB_FOLDER_ID\"      // string (ObjectId) or null, optional - Target folder ID to move file to
    }"
    make_api_call "PUT" "/api/v2/drive-files/$FILE_ID/move" "$move_data" "Move File to Sub-Folder"
fi

echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}          CLEANUP OPERATIONS${NC}"
echo -e "${BLUE}======================================${NC}"
echo ""

# Cleanup: Delete File (if created)
if [ -n "$FILE_ID" ]; then
    make_api_call "DELETE" "/api/v2/drive-files/$FILE_ID" "" "Delete File"
fi

# Cleanup: Delete Sub-Folder (if created)
if [ -n "$SUB_FOLDER_ID" ]; then
    make_api_call "DELETE" "/api/v2/drive-folders/$SUB_FOLDER_ID" "" "Delete Sub-Folder"
fi

# Cleanup: Delete Main Folder (if created)
if [ -n "$FOLDER_ID" ]; then
    make_api_call "DELETE" "/api/v2/drive-folders/$FOLDER_ID" "" "Delete Main Folder"
fi

echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}          TESTING COMPLETE${NC}"
echo -e "${BLUE}======================================${NC}"
echo ""
echo -e "${YELLOW}Note: Make sure your server is running on $BASE_URL${NC}"
echo -e "${YELLOW}Note: Update ACCESS_TOKEN with a valid token before running${NC}"
echo ""