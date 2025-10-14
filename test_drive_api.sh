#!/bin/bash

# Test script for Zillit Drive APIs
BASE_URL="http://localhost:8105"
MODULE_DATA="934a93cdef3e6aa550a1f18ed87db20e0298c982058539417f56919361658e7c440042945616eb953cf3d2a6a770099d61c21572941067951ccab89f96d8d6f171ffac1cf6441748d9079cf43be976a9a122acca46b7b3d4b2dab23f705e27a8f10aeb04a3a07cd94d7681c225f9dbf1d6bb281fd7ab4eec09b11985fecf47e32bff6b4ff7fc9fc4a7b1f57184d613e97cc9a9afbfb903fe64f50ec68a7d17f4d0ec09cc86d65ddd10dde1c0b47c249c654dc5af16b769ece7008efe56fa27652d259984135e1ec1316bb74fc0fb268a99ca60b31481b538af36db916b40e709"

echo "=== Testing Zillit Drive APIs ==="

echo -e "\n1. Testing Health Check..."
curl -s -H "moduleData: $MODULE_DATA" "$BASE_URL/api/v2/health" | jq .

echo -e "\n2. Creating a root folder..."
FOLDER_RESPONSE=$(curl -s -X POST "$BASE_URL/api/v2/drive/folders" \
  -H "Content-Type: application/json" \
  -H "moduleData: $MODULE_DATA" \
  -d '{
    "folder_name": "Test Documents",
    "description": "A test folder for API testing",
    "project_id": "507f1f77bcf86cd799439011"
  }')

echo "$FOLDER_RESPONSE" | jq .
FOLDER_ID=$(echo "$FOLDER_RESPONSE" | jq -r '.data._id // empty')

if [ -n "$FOLDER_ID" ] && [ "$FOLDER_ID" != "null" ]; then
  echo "Created folder with ID: $FOLDER_ID"

  echo -e "\n3. Creating a subfolder..."
  SUBFOLDER_RESPONSE=$(curl -s -X POST "$BASE_URL/api/v2/drive/folders" \
    -H "Content-Type: application/json" \
    -H "moduleData: $MODULE_DATA" \
    -d "{
      \"folder_name\": \"Reports\",
      \"description\": \"Monthly reports subfolder\",
      \"parent_folder_id\": \"$FOLDER_ID\",
      \"project_id\": \"507f1f77bcf86cd799439011\"
    }")

  echo "$SUBFOLDER_RESPONSE" | jq .

  echo -e "\n4. Creating a file (folder with attachments)..."
  curl -s -X POST "$BASE_URL/api/v2/drive/folders" \
    -H "Content-Type: application/json" \
    -H "moduleData: $MODULE_DATA" \
    -d "{
      \"folder_name\": \"Important Document.pdf\",
      \"description\": \"An important PDF document\",
      \"parent_folder_id\": \"$FOLDER_ID\",
      \"project_id\": \"507f1f77bcf86cd799439011\",
      \"attachments\": [
        {
          \"media\": \"https://example.com/document.pdf\",
          \"name\": \"Important Document.pdf\",
          \"content_type\": \"document\",
          \"content_subtype\": \"pdf\",
          \"file_size\": \"1024000\"
        }
      ]
    }" | jq .

  echo -e "\n5. Getting all folders..."
  curl -s -H "moduleData: $MODULE_DATA" "$BASE_URL/api/v2/drive/folders" | jq .

  echo -e "\n6. Getting folder by ID..."
  curl -s -H "moduleData: $MODULE_DATA" "$BASE_URL/api/v2/drive/folders/$FOLDER_ID" | jq .

else
  echo "Failed to create folder or extract ID"
fi

echo -e "\n=== API Testing Complete ==="
