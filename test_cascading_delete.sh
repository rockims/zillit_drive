#!/bin/bash

# Test script for cascading delete functionality
BASE_URL="http://localhost:8105"
MODULE_DATA="934a93cdef3e6aa550a1f18ed87db20e0298c982058539417f56919361658e7c440042945616eb953cf3d2a6a770099d61c21572941067951ccab89f96d8d6f171ffac1cf6441748d9079cf43be976a9a122acca46b7b3d4b2dab23f705e27a8f10aeb04a3a07cd94d7681c225f9dbf1d6bb281fd7ab4eec09b11985fecf47e32bff6b4ff7fc9fc4a7b1f57184d613e97cc9a9afbfb903fe64f50ec68a7d17f4d0ec09cc86d65ddd10dde1c0b47c249c654dc5af16b769ece7008efe56fa27652d259984135e1ec1316bb74fc0fb268a99ca60b31481b538af36db916b40e709"

echo "=== Testing Cascading Delete Functionality ==="

echo -e "\n1. Creating root folder..."
ROOT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/v2/drive/folders" \
  -H "Content-Type: application/json" \
  -H "moduleData: $MODULE_DATA" \
  -d '{
    "folder_name": "Root Folder",
    "description": "Root folder for cascading delete test"
  }')

echo "$ROOT_RESPONSE" | jq .
ROOT_ID=$(echo "$ROOT_RESPONSE" | jq -r '.data._id // empty')

if [ -n "$ROOT_ID" ] && [ "$ROOT_ID" != "null" ]; then
  echo "Created root folder with ID: $ROOT_ID"

  echo -e "\n2. Creating subfolder..."
  SUB_RESPONSE=$(curl -s -X POST "$BASE_URL/api/v2/drive/folders" \
    -H "Content-Type: application/json" \
    -H "moduleData: $MODULE_DATA" \
    -d "{
      \"folder_name\": \"Subfolder\",
      \"description\": \"Subfolder for testing\",
      \"parent_folder_id\": \"$ROOT_ID\"
    }")

  echo "$SUB_RESPONSE" | jq .
  SUB_ID=$(echo "$SUB_RESPONSE" | jq -r '.data._id // empty')

  echo -e "\n3. Creating nested subfolder..."
  NESTED_RESPONSE=$(curl -s -X POST "$BASE_URL/api/v2/drive/folders" \
    -H "Content-Type: application/json" \
    -H "moduleData: $MODULE_DATA" \
    -d "{
      \"folder_name\": \"Nested Subfolder\",
      \"description\": \"Deeply nested folder\",
      \"parent_folder_id\": \"$SUB_ID\"
    }")

  echo "$NESTED_RESPONSE" | jq .
  NESTED_ID=$(echo "$NESTED_RESPONSE" | jq -r '.data._id // empty')

  echo -e "\n4. Creating file in root folder..."
  curl -s -X POST "$BASE_URL/api/v2/drive/files" \
    -H "Content-Type: application/json" \
    -H "moduleData: $MODULE_DATA" \
    -d "{
      \"file_name\": \"Root File.txt\",
      \"description\": \"File in root folder\",
      \"folder_id\": \"$ROOT_ID\",
      \"mimeType\": \"text/plain\",
      \"size\": 1024
    }" | jq .

  echo -e "\n5. Creating file in subfolder..."
  curl -s -X POST "$BASE_URL/api/v2/drive/files" \
    -H "Content-Type: application/json" \
    -H "moduleData: $MODULE_DATA" \
    -d "{
      \"file_name\": \"Sub File.pdf\",
      \"description\": \"File in subfolder\",
      \"folder_id\": \"$SUB_ID\",
      \"mimeType\": \"application/pdf\",
      \"size\": 2048
    }" | jq .

  echo -e "\n6. Creating file in nested subfolder..."
  curl -s -X POST "$BASE_URL/api/v2/drive/files" \
    -H "Content-Type: application/json" \
    -H "moduleData: $MODULE_DATA" \
    -d "{
      \"file_name\": \"Nested File.jpg\",
      \"description\": \"File in nested folder\",
      \"folder_id\": \"$NESTED_ID\",
      \"mimeType\": \"image/jpeg\",
      \"size\": 4096
    }" | jq .

  echo -e "\n7. Getting all folders and files before deletion..."
  echo "Folders:"
  curl -s -H "moduleData: $MODULE_DATA" "$BASE_URL/api/v2/drive/folders" | jq '.data[] | {_id, folder_name, parent_folder_id}'
  echo "Files:"
  curl -s -H "moduleData: $MODULE_DATA" "$BASE_URL/api/v2/drive/files" | jq '.data[] | {_id, file_name, folder_id}'

  echo -e "\n8. DELETING ROOT FOLDER (should cascade delete everything)..."
  DELETE_RESPONSE=$(curl -s -X DELETE "$BASE_URL/api/v2/drive/folders/$ROOT_ID" \
    -H "moduleData: $MODULE_DATA")

  echo "$DELETE_RESPONSE" | jq .

  echo -e "\n9. Verifying deletion - checking remaining folders..."
  REMAINING_FOLDERS=$(curl -s -H "moduleData: $MODULE_DATA" "$BASE_URL/api/v2/drive/folders")
  echo "Remaining folders:"
  echo "$REMAINING_FOLDERS" | jq '.data[] | select(.folder_name | contains("Root") or contains("Sub") or contains("Nested")) | {_id, folder_name, deleted_on}'

  echo -e "\n10. Verifying deletion - checking remaining files..."
  REMAINING_FILES=$(curl -s -H "moduleData: $MODULE_DATA" "$BASE_URL/api/v2/drive/files")
  echo "Remaining files:"
  echo "$REMAINING_FILES" | jq '.data[] | select(.file_name != null and (.file_name | contains("Root") or contains("Sub") or contains("Nested"))) | {_id, file_name, deleted_on}'

else
  echo "Failed to create root folder"
fi

echo -e "\n=== Cascading Delete Test Complete ==="
