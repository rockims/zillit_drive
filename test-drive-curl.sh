#!/bin/bash

# Drive API Test Script - Bash/curl version
# 
# This script tests the zillit drive API using curl commands
# Make sure the server is running on localhost:8105
#
# Usage: chmod +x test-drive-curl.sh && ./test-drive-curl.sh

set -e  # Exit on any error

# Configuration
BASE_URL="http://localhost:8105/api/v2"
SERVER_URL="http://localhost:8105"

# Test data - Replace these with actual IDs from your system
PROJECT_ID="507f1f77bcf86cd799439011"
DEVICE_ID="507f1f77bcf86cd799439012"
USER_ID="507f1f77bcf86cd799439013"
SHARE_USER_ID="507f1f77bcf86cd799439099"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

separator() {
    echo "----------------------------------------"
}

# Test variables to store created resource IDs
FOLDER_ID=""
FILE_ID=""
SECOND_FOLDER_ID=""

# Test 1: Health Check
test_health_check() {
    log_info "Testing health check..."
    
    response=$(curl -s -w "\n%{http_code}" "$SERVER_URL/")
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n -1)
    
    if [ "$http_code" = "200" ]; then
        log_success "Health check passed"
        echo "Response: $body"
    else
        log_error "Health check failed with status $http_code"
        echo "Response: $body"
        exit 1
    fi
    separator
}

# Test 2: Create Folder
test_create_folder() {
    log_info "Testing folder creation..."
    
    response=$(curl -s -w "\n%{http_code}" -X POST \
        -H "Content-Type: application/json" \
        -H "device-id: $DEVICE_ID" \
        -H "project-id: $PROJECT_ID" \
        -H "user-id: $USER_ID" \
        -d '{
            "folder_name": "Test Shared Folder",
            "description": "A test folder for sharing files",
            "parent_folder_id": null
        }' \
        "$BASE_URL/drive/folders")
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n -1)
    
    if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
        log_success "Folder created successfully"
        echo "Response: $body"
        
        # Extract folder ID for later use
        FOLDER_ID=$(echo "$body" | grep -o '"_id":"[^"]*"' | head -1 | cut -d'"' -f4)
        log_info "Created folder ID: $FOLDER_ID"
    else
        log_error "Folder creation failed with status $http_code"
        echo "Response: $body"
    fi
    separator
}

# Test 3: Get Folders
test_get_folders() {
    log_info "Testing get folders..."
    
    response=$(curl -s -w "\n%{http_code}" \
        -H "device-id: $DEVICE_ID" \
        -H "project-id: $PROJECT_ID" \
        -H "user-id: $USER_ID" \
        "$BASE_URL/drive/folders")
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n -1)
    
    if [ "$http_code" = "200" ]; then
        log_success "Folders retrieved successfully"
        echo "Response: $body"
    else
        log_error "Get folders failed with status $http_code"
        echo "Response: $body"
    fi
    separator
}

# Test 4: Create File
test_create_file() {
    if [ -z "$FOLDER_ID" ]; then
        log_warning "No folder ID available, skipping file creation"
        return
    fi
    
    log_info "Testing file creation..."
    
    response=$(curl -s -w "\n%{http_code}" -X POST \
        -H "Content-Type: application/json" \
        -H "device-id: $DEVICE_ID" \
        -H "project-id: $PROJECT_ID" \
        -H "user-id: $USER_ID" \
        -d "{
            \"folder_id\": \"$FOLDER_ID\",
            \"file_name\": \"test-document.txt\",
            \"original_file_name\": \"test-document.txt\",
            \"file_path\": \"/uploads/test-document.txt\",
            \"file_url\": \"https://example.com/files/test-document.txt\",
            \"file_size\": 1024,
            \"file_type\": \"document\",
            \"mime_type\": \"text/plain\",
            \"file_extension\": \"txt\",
            \"description\": \"A test document for sharing\",
            \"tags\": [\"test\", \"document\", \"sharing\"]
        }" \
        "$BASE_URL/drive/files")
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n -1)
    
    if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
        log_success "File created successfully"
        echo "Response: $body"
        
        # Extract file ID for later use
        FILE_ID=$(echo "$body" | grep -o '"_id":"[^"]*"' | head -1 | cut -d'"' -f4)
        log_info "Created file ID: $FILE_ID"
    else
        log_error "File creation failed with status $http_code"
        echo "Response: $body"
    fi
    separator
}

# Test 5: Get Files
test_get_files() {
    log_info "Testing get files..."
    
    url="$BASE_URL/drive/files"
    if [ -n "$FOLDER_ID" ]; then
        url="$url?folder_id=$FOLDER_ID"
    fi
    
    response=$(curl -s -w "\n%{http_code}" \
        -H "device-id: $DEVICE_ID" \
        -H "project-id: $PROJECT_ID" \
        -H "user-id: $USER_ID" \
        "$url")
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n -1)
    
    if [ "$http_code" = "200" ]; then
        log_success "Files retrieved successfully"
        echo "Response: $body"
    else
        log_error "Get files failed with status $http_code"
        echo "Response: $body"
    fi
    separator
}

# Test 6: Update File with Sharing
test_update_file_sharing() {
    if [ -z "$FILE_ID" ]; then
        log_warning "No file ID available, skipping file sharing update"
        return
    fi
    
    log_info "Testing file sharing update..."
    
    response=$(curl -s -w "\n%{http_code}" -X PUT \
        -H "Content-Type: application/json" \
        -H "device-id: $DEVICE_ID" \
        -H "project-id: $PROJECT_ID" \
        -H "user-id: $USER_ID" \
        -d "{
            \"is_shared\": true,
            \"shared_with\": [{
                \"user_id\": \"$SHARE_USER_ID\",
                \"permissions\": \"read\",
                \"shared_on\": \"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\"
            }],
            \"description\": \"Updated file with sharing enabled\"
        }" \
        "$BASE_URL/drive/files/$FILE_ID")
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n -1)
    
    if [ "$http_code" = "200" ]; then
        log_success "File sharing updated successfully"
        echo "Response: $body"
    else
        log_error "File sharing update failed with status $http_code"
        echo "Response: $body"
    fi
    separator
}

# Test 7: Get Specific File
test_get_specific_file() {
    if [ -z "$FILE_ID" ]; then
        log_warning "No file ID available, skipping get specific file"
        return
    fi
    
    log_info "Testing get specific file..."
    
    response=$(curl -s -w "\n%{http_code}" \
        -H "device-id: $DEVICE_ID" \
        -H "project-id: $PROJECT_ID" \
        -H "user-id: $USER_ID" \
        "$BASE_URL/drive/files/$FILE_ID")
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n -1)
    
    if [ "$http_code" = "200" ]; then
        log_success "Specific file retrieved successfully"
        echo "Response: $body"
    else
        log_error "Get specific file failed with status $http_code"
        echo "Response: $body"
    fi
    separator
}

# Test 8: Get Folder Contents
test_get_folder_contents() {
    if [ -z "$FOLDER_ID" ]; then
        log_warning "No folder ID available, skipping get folder contents"
        return
    fi
    
    log_info "Testing get folder contents..."
    
    response=$(curl -s -w "\n%{http_code}" \
        -H "device-id: $DEVICE_ID" \
        -H "project-id: $PROJECT_ID" \
        -H "user-id: $USER_ID" \
        "$BASE_URL/drive/folders/$FOLDER_ID/contents")
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n -1)
    
    if [ "$http_code" = "200" ]; then
        log_success "Folder contents retrieved successfully"
        echo "Response: $body"
    else
        log_error "Get folder contents failed with status $http_code"
        echo "Response: $body"
    fi
    separator
}

# Test 9: Get Files by Type
test_get_files_by_type() {
    log_info "Testing get files by type..."
    
    response=$(curl -s -w "\n%{http_code}" \
        -H "device-id: $DEVICE_ID" \
        -H "project-id: $PROJECT_ID" \
        -H "user-id: $USER_ID" \
        "$BASE_URL/drive/files/by-type?file_type=document")
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n -1)
    
    if [ "$http_code" = "200" ]; then
        log_success "Files by type retrieved successfully"
        echo "Response: $body"
    else
        log_error "Get files by type failed with status $http_code"
        echo "Response: $body"
    fi
    separator
}

# Cleanup function
cleanup() {
    log_info "Cleaning up test resources..."
    
    # Delete file if created
    if [ -n "$FILE_ID" ]; then
        log_info "Deleting file $FILE_ID..."
        curl -s -X DELETE \
            -H "device-id: $DEVICE_ID" \
            -H "project-id: $PROJECT_ID" \
            -H "user-id: $USER_ID" \
            "$BASE_URL/drive/files/$FILE_ID"
        log_success "File deletion requested"
    fi
    
    # Delete second folder if created
    if [ -n "$SECOND_FOLDER_ID" ]; then
        log_info "Deleting second folder $SECOND_FOLDER_ID..."
        curl -s -X DELETE \
            -H "device-id: $DEVICE_ID" \
            -H "project-id: $PROJECT_ID" \
            -H "user-id: $USER_ID" \
            "$BASE_URL/drive/folders/$SECOND_FOLDER_ID"
        log_success "Second folder deletion requested"
    fi
    
    # Delete main folder if created
    if [ -n "$FOLDER_ID" ]; then
        log_info "Deleting folder $FOLDER_ID..."
        curl -s -X DELETE \
            -H "device-id: $DEVICE_ID" \
            -H "project-id: $PROJECT_ID" \
            -H "user-id: $USER_ID" \
            "$BASE_URL/drive/folders/$FOLDER_ID"
        log_success "Folder deletion requested"
    fi
    
    separator
}

# Main execution
main() {
    echo "🚀 Starting Drive API Tests with curl..."
    echo "Make sure the server is running on $SERVER_URL"
    separator
    
    # Run tests
    test_health_check
    test_create_folder
    test_get_folders
    test_create_file
    test_get_files
    test_update_file_sharing
    test_get_specific_file
    test_get_folder_contents
    test_get_files_by_type
    
    echo ""
    log_success "All tests completed!"
    
    # Print summary
    echo ""
    echo "📊 Test Summary:"
    echo "- Health Check: ✅"
    echo "- Folder Creation: $([ -n "$FOLDER_ID" ] && echo "✅" || echo "❌")"
    echo "- Get Folders: ✅"
    echo "- File Creation: $([ -n "$FILE_ID" ] && echo "✅" || echo "❌")"
    echo "- Get Files: ✅"
    echo "- File Sharing Update: ✅"
    echo "- Get Specific File: ✅"
    echo "- Get Folder Contents: ✅"
    echo "- Get Files by Type: ✅"
    
    separator
    cleanup
}

# Handle script interruption
trap cleanup EXIT

# Run main function
main
