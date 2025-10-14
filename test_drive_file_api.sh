#!/bin/bash

# Test script for Zillit DriveFile APIs
BASE_URL="http://localhost:8105"
MODULE_DATA="934a93cdef3e6aa550a1f18ed87db20e0298c982058539417f56919361658e7c440042945616eb953cf3d2a6a770099d61c21572941067951ccab89f96d8d6f171ffac1cf6441748d9079cf43be976a9a122acca46b7b3d4b2dab23f705e27a8f10aeb04a3a07cd94d7681c225f9dbf1d6bb281fd7ab4eec09b11985fecf47e32bff6b4ff7fc9fc4a7b1f57184d613e97cc9a9afbfb903fe64f50ec68a7d17f4d0ec09cc86d65ddd10dde1c0b47c249c654dc5af16b769ece7008efe56fa27652d259984135e1ec1316bb74fc0fb268a99ca60b31481b538af36db916b40e709"

echo "=== Testing Zillit DriveFile APIs ==="

echo -e "\n1. Testing Health Check..."
curl -s -H "moduleData: $MODULE_DATA" "$BASE_URL/api/v2/health" | jq .

echo -e "\n2. Creating a file in root directory..."
FILE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/v2/drive/files" \
  -H "Content-Type: application/json" \
  -H "moduleData: $MODULE_DATA" \
  -d '{
    "file_name": "test_document.pdf",
    "description": "Test PDF document",
    "file_type": "document",
    "mime_type": "application/pdf",
    "file_size": "1.5 MB",
    "file_size_bytes": 1572864,
    "attachment": {
      "url": "https://example.com/documents/test.pdf",
      "original_name": "test_document.pdf",
      "size": 1572864,
      "mime_type": "application/pdf"
    }
  }')

echo "$FILE_RESPONSE" | jq .
FILE_ID=$(echo "$FILE_RESPONSE" | jq -r '.data._id // empty')

echo -e "\n3. Creating a folder for file organization..."
FOLDER_RESPONSE=$(curl -s -X POST "$BASE_URL/api/v2/drive/folders" \
  -H "Content-Type: application/json" \
  -H "moduleData: $MODULE_DATA" \
  -d '{
    "folder_name": "Test Files Folder",
    "description": "A folder for organizing test files"
  }')

FOLDER_ID=$(echo "$FOLDER_RESPONSE" | jq -r '.data._id // empty')
echo "Created folder with ID: $FOLDER_ID"

if [ -n "$FILE_ID" ] && [ "$FILE_ID" != "null" ]; then
  echo "Created file with ID: $FILE_ID"

  echo -e "\n4. Creating a file in the folder..."
  curl -s -X POST "$BASE_URL/api/v2/drive/files" \
    -H "Content-Type: application/json" \
    -H "moduleData: $MODULE_DATA" \
    -d "{
      \"file_name\": \"folder_document.xlsx\",
      \"folder_id\": \"$FOLDER_ID\",
      \"description\": \"Excel file in folder\",
      \"file_type\": \"spreadsheet\",
      \"mime_type\": \"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\",
      \"file_size\": \"800 KB\",
      \"file_size_bytes\": 819200,
      \"attachment\": {
        \"url\": \"https://example.com/sheets/data.xlsx\",
        \"original_name\": \"folder_document.xlsx\",
        \"size\": 819200,
        \"mime_type\": \"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\"
      }
    }" | jq .

  echo -e "\n5. Getting all files..."
  curl -s -H "moduleData: $MODULE_DATA" "$BASE_URL/api/v2/drive/files" | jq .

  echo -e "\n6. Getting files by folder..."
  if [ -n "$FOLDER_ID" ] && [ "$FOLDER_ID" != "null" ]; then
    curl -s -H "moduleData: $MODULE_DATA" "$BASE_URL/api/v2/drive/files?folder_id=$FOLDER_ID" | jq .
  fi

  echo -e "\n7. Getting files by type (document)..."
  curl -s -H "moduleData: $MODULE_DATA" "$BASE_URL/api/v2/drive/files/by-type?file_type=document" | jq .

  echo -e "\n8. Getting file by ID..."
  curl -s -H "moduleData: $MODULE_DATA" "$BASE_URL/api/v2/drive/files/$FILE_ID" | jq .

  echo -e "\n9. Updating file information..."
  curl -s -X PUT "$BASE_URL/api/v2/drive/files/$FILE_ID" \
    -H "Content-Type: application/json" \
    -H "moduleData: $MODULE_DATA" \
    -d '{
      "file_name": "updated_test_document.pdf",
      "description": "Updated PDF document with new content"
    }' | jq .

  echo -e "\n10. Moving file to folder..."
  if [ -n "$FOLDER_ID" ] && [ "$FOLDER_ID" != "null" ]; then
    curl -s -X PUT "$BASE_URL/api/v2/drive/files/$FILE_ID/move" \
      -H "Content-Type: application/json" \
      -H "moduleData: $MODULE_DATA" \
      -d "{
        \"target_folder_id\": \"$FOLDER_ID\"
      }" | jq .
  fi

  echo -e "\n11. Creating a file to delete..."
  DELETE_FILE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/v2/drive/files" \
    -H "Content-Type: application/json" \
    -H "moduleData: $MODULE_DATA" \
    -d '{
      "file_name": "temporary_file.txt",
      "description": "This file will be deleted",
      "file_type": "text",
      "mime_type": "text/plain"
    }')

  DELETE_FILE_ID=$(echo "$DELETE_FILE_RESPONSE" | jq -r '.data._id // empty')

  if [ -n "$DELETE_FILE_ID" ] && [ "$DELETE_FILE_ID" != "null" ]; then
    echo "Created temporary file with ID: $DELETE_FILE_ID"

    echo -e "\n12. Deleting the temporary file..."
    curl -s -X DELETE "$BASE_URL/api/v2/drive/files/$DELETE_FILE_ID" \
      -H "moduleData: $MODULE_DATA" | jq .
  fi

else
  echo "Failed to create file or extract ID"
fi

echo -e "\n=== DriveFile API Testing Complete ==="
