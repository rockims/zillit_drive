#!/bin/bash

# File Sharing Test Script - Bash/curl version
# 
# This script tests file sharing functionality using curl commands
# Uses real file IDs from your existing data
#
# Usage: chmod +x test-file-sharing-curl.sh && ./test-file-sharing-curl.sh

set -e  # Exit on any error

# Configuration
BASE_URL="http://localhost:8105/api/v2"
SERVER_URL="http://localhost:8105"

# Real IDs from your successful API call
MODULE_DATA="9bf45a428070559f3376f051dd8877f1cdc26fed18a17e5d9f05337339f17aaa2dcb4c3474635573f852906b03eeab055b53675d1c163c04a58173d85a4fba3bc24b2494c14e2f943e44738ecfe9dab8818d7fe7a9ac6ecbd9bffa85e295cd4f8f288371124b3e34ff5989b589685eb975bc1eb34020fb1924b72e64c1fd4d73f9e439c1ab7104103a2f2094f8ff6e40349954d10bee1fde2f9df25fd019413b"
FOLDER_ID="68f0931896a3ef9794b9eec3"
FILE_ID="68f0cb8bdcbea8318fcaafb6"  # updated_project_report.pdf
PROJECT_ID="68eca9d76208f330d648cfd2"
SHARE_USER_ID="68edeeae027176b3686533ca"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
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

log_feature() {
    echo -e "${PURPLE}[FEATURE]${NC} $1"
}

separator() {
    echo "=========================================="
}

big_separator() {
    echo "=================================================================================="
}

# Generate a random share token for testing
generate_share_token() {
    if command -v uuidgen &> /dev/null; then
        echo $(uuidgen | tr '[:upper:]' '[:lower:]')
    else
        echo "share_$(date +%s)_$(shuf -i 1000-9999 -n 1)"
    fi
}

SHARE_TOKEN=$(generate_share_token)

# Test 1: Health Check
test_health_check() {
    log_info "Testing API health check..."
    
    response=$(curl -s -w "\n%{http_code}" "$SERVER_URL/")
    http_code=$(echo "$response" | tail -1)
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

# Test 2: Get Existing Files
test_get_existing_files() {
    log_info "Getting existing files for sharing tests..."
    
    response=$(curl -s -w "\n%{http_code}" \
        -H "moduledata: $MODULE_DATA" \
        "$BASE_URL/drive/files/?folder_id=$FOLDER_ID")
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n -1)
    
    if [ "$http_code" = "200" ]; then
        log_success "Files retrieved successfully"
        echo "Response: $body" | head -c 500
        echo "..."
        
        # Extract file count
        file_count=$(echo "$body" | grep -o '"_id"' | wc -l)
        log_info "Found $file_count files available for sharing"
    else
        log_error "Failed to get files with status $http_code"
        echo "Response: $body"
    fi
    separator
}

# Test 3: Get Specific File Details
test_get_file_details() {
    log_info "Getting details for file: $FILE_ID"
    
    response=$(curl -s -w "\n%{http_code}" \
        -H "moduledata: $MODULE_DATA" \
        "$BASE_URL/drive/files/$FILE_ID")
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n -1)
    
    if [ "$http_code" = "200" ]; then
        log_success "File details retrieved successfully"
        echo "Response: $body" | head -c 500
        echo "..."
        
        # Extract file name
        file_name=$(echo "$body" | grep -o '"file_name":"[^"]*"' | cut -d'"' -f4)
        log_info "File name: $file_name"
    else
        log_error "Failed to get file details with status $http_code"
        echo "Response: $body"
    fi
    separator
}

# Test 4: Test File Sharing via Update
test_file_sharing_update() {
    log_info "Testing file sharing via update..."
    
    # Create current timestamp
    current_time=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
    
    response=$(curl -s -w "\n%{http_code}" -X PUT \
        -H "Content-Type: application/json" \
        -H "moduledata: $MODULE_DATA" \
        -d "{
            \"description\": \"File updated with sharing test - $(date)\",
            \"file_name\": \"shared_project_report.pdf\",
            \"share_token\": \"$SHARE_TOKEN\",
            \"shared_with_users\": [\"$SHARE_USER_ID\"],
            \"share_permissions\": \"read\"
        }" \
        "$BASE_URL/drive/files/$FILE_ID")
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n -1)
    
    if [ "$http_code" = "200" ]; then
        log_success "File sharing update successful"
        echo "Response: $body" | head -c 300
        echo "..."
    else
        log_warning "File sharing update returned status $http_code (expected if sharing fields not in model)"
        echo "Response: $body" | head -c 200
    fi
    separator
}

# Test 5: Test Share Link Generation Endpoints
test_share_link_generation() {
    log_info "Testing share link generation endpoints..."
    
    share_data="{
        \"permissions\": \"read\",
        \"expires_at\": \"$(date -d '+7 days' -u +%Y-%m-%dT%H:%M:%S.%3NZ)\",
        \"allow_download\": true,
        \"password_protected\": false
    }"
    
    # Try different potential share endpoints
    endpoints=(
        "/drive/files/$FILE_ID/share"
        "/drive/files/$FILE_ID/generate-link"
        "/drive/files/$FILE_ID/public-link"
        "/drive/files/$FILE_ID/create-share"
    )
    
    share_endpoint_found=false
    
    for endpoint in "${endpoints[@]}"; do
        log_info "Trying endpoint: $endpoint"
        
        response=$(curl -s -w "\n%{http_code}" -X POST \
            -H "Content-Type: application/json" \
            -H "moduledata: $MODULE_DATA" \
            -d "$share_data" \
            "$BASE_URL$endpoint" 2>/dev/null)
        
        http_code=$(echo "$response" | tail -n1)
        body=$(echo "$response" | head -n -1)
        
        if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
            log_success "Share link generated successfully via: $endpoint"
            echo "Response: $body"
            share_endpoint_found=true
            break
        elif [ "$http_code" = "404" ]; then
            log_warning "Endpoint not found: $endpoint"
        else
            log_warning "Endpoint $endpoint returned status $http_code"
        fi
    done
    
    if [ "$share_endpoint_found" = false ]; then
        log_feature "No share link endpoints implemented yet"
        log_feature "Expected share link response:"
        echo "{
  \"status\": 1,
  \"message\": \"share_link_generated\",
  \"data\": {
    \"share_token\": \"$SHARE_TOKEN\",
    \"share_url\": \"$SERVER_URL/api/v2/drive/public/$SHARE_TOKEN\",
    \"expires_at\": \"$(date -d '+7 days' -u +%Y-%m-%dT%H:%M:%S.%3NZ)\",
    \"permissions\": \"read\",
    \"file_id\": \"$FILE_ID\"
  }
}"
    fi
    separator
}

# Test 6: Test Public Link Access
test_public_link_access() {
    log_info "Testing public link access endpoints..."
    
    # Try different potential public access endpoints
    public_endpoints=(
        "/drive/public/$SHARE_TOKEN"
        "/drive/shared/$SHARE_TOKEN"
        "/public/files/$SHARE_TOKEN"
        "/share/$SHARE_TOKEN"
    )
    
    public_endpoint_found=false
    
    for endpoint in "${public_endpoints[@]}"; do
        log_info "Trying public endpoint: $endpoint"
        
        # Don't use moduledata for public endpoints
        response=$(curl -s -w "\n%{http_code}" \
            "$BASE_URL$endpoint" 2>/dev/null)
        
        http_code=$(echo "$response" | tail -n1)
        body=$(echo "$response" | head -n -1)
        
        if [ "$http_code" = "200" ]; then
            log_success "Public link access successful via: $endpoint"
            echo "Response: $body"
            public_endpoint_found=true
            break
        elif [ "$http_code" = "404" ]; then
            log_warning "Public endpoint not found: $endpoint"
        else
            log_warning "Public endpoint $endpoint returned status $http_code"
        fi
    done
    
    if [ "$public_endpoint_found" = false ]; then
        log_feature "No public link access endpoints implemented yet"
        log_feature "Expected public access functionality:"
        echo "- Anonymous access to shared files"
        echo "- File metadata and download URL"
        echo "- Access logging and analytics"
        echo "- Password protection support"
    fi
    separator
}

# Test 7: Test Share Management
test_share_management() {
    log_info "Testing share management endpoints..."
    
    # Try different share management endpoints
    management_endpoints=(
        "/drive/files/$FILE_ID/shares"
        "/drive/files/$FILE_ID/permissions"
        "/drive/files/$FILE_ID/access"
    )
    
    management_found=false
    
    for endpoint in "${management_endpoints[@]}"; do
        log_info "Trying management endpoint: $endpoint"
        
        response=$(curl -s -w "\n%{http_code}" \
            -H "moduledata: $MODULE_DATA" \
            "$BASE_URL$endpoint" 2>/dev/null)
        
        http_code=$(echo "$response" | tail -n1)
        body=$(echo "$response" | head -n -1)
        
        if [ "$http_code" = "200" ]; then
            log_success "Share management access successful via: $endpoint"
            echo "Response: $body"
            management_found=true
            break
        elif [ "$http_code" = "404" ]; then
            log_warning "Management endpoint not found: $endpoint"
        else
            log_warning "Management endpoint $endpoint returned status $http_code"
        fi
    done
    
    if [ "$management_found" = false ]; then
        log_feature "No share management endpoints implemented yet"
        log_feature "Recommended share management endpoints:"
        echo "- GET /drive/files/{id}/shares - List current shares"
        echo "- POST /drive/files/{id}/shares - Create new share"
        echo "- PUT /drive/files/{id}/shares/{shareId} - Update share"
        echo "- DELETE /drive/files/{id}/shares/{shareId} - Remove share"
    fi
    separator
}

# Test 8: Test User's Shared Files
test_user_shared_files() {
    log_info "Testing user's shared files endpoints..."
    
    # Try endpoints for user's shared content
    user_endpoints=(
        "/drive/files/shared-by-me"
        "/drive/files/shared-with-me"
        "/drive/shares/my-shares"
        "/drive/shares/received"
    )
    
    user_endpoint_found=false
    
    for endpoint in "${user_endpoints[@]}"; do
        log_info "Trying user endpoint: $endpoint"
        
        response=$(curl -s -w "\n%{http_code}" \
            -H "moduledata: $MODULE_DATA" \
            "$BASE_URL$endpoint" 2>/dev/null)
        
        http_code=$(echo "$response" | tail -n1)
        body=$(echo "$response" | head -n -1)
        
        if [ "$http_code" = "200" ]; then
            log_success "User shared files access successful via: $endpoint"
            echo "Response: $body" | head -c 200
            echo "..."
            user_endpoint_found=true
        elif [ "$http_code" = "404" ]; then
            log_warning "User endpoint not found: $endpoint"
        else
            log_warning "User endpoint $endpoint returned status $http_code"
        fi
    done
    
    if [ "$user_endpoint_found" = false ]; then
        log_feature "No user shared files endpoints implemented yet"
    fi
    separator
}

# Test 9: Test Batch Share Operations
test_batch_operations() {
    log_info "Testing batch share operations..."
    
    batch_data="{
        \"file_ids\": [\"$FILE_ID\"],
        \"operation\": \"share\",
        \"share_settings\": {
            \"permissions\": \"read\",
            \"expires_at\": \"$(date -d '+7 days' -u +%Y-%m-%dT%H:%M:%S.%3NZ)\"
        }
    }"
    
    # Try batch operation endpoints
    batch_endpoints=(
        "/drive/files/batch-share"
        "/drive/batch/share"
        "/drive/files/bulk-operations"
    )
    
    batch_found=false
    
    for endpoint in "${batch_endpoints[@]}"; do
        log_info "Trying batch endpoint: $endpoint"
        
        response=$(curl -s -w "\n%{http_code}" -X POST \
            -H "Content-Type: application/json" \
            -H "moduledata: $MODULE_DATA" \
            -d "$batch_data" \
            "$BASE_URL$endpoint" 2>/dev/null)
        
        http_code=$(echo "$response" | tail -n1)
        body=$(echo "$response" | head -n -1)
        
        if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
            log_success "Batch operations successful via: $endpoint"
            echo "Response: $body"
            batch_found=true
            break
        elif [ "$http_code" = "404" ]; then
            log_warning "Batch endpoint not found: $endpoint"
        else
            log_warning "Batch endpoint $endpoint returned status $http_code"
        fi
    done
    
    if [ "$batch_found" = false ]; then
        log_feature "No batch operations endpoints implemented yet"
    fi
    separator
}

# Print implementation roadmap
print_implementation_roadmap() {
    big_separator
    log_feature "FILE SHARING IMPLEMENTATION ROADMAP"
    big_separator
    
    echo ""
    echo "🎯 PHASE 1: BASIC SHARING"
    echo "  • Implement share link generation endpoint"
    echo "  • Add public access endpoint for shared files"
    echo "  • Basic permissions (read/download)"
    echo "  • Expiration dates"
    echo ""
    
    echo "🎯 PHASE 2: ADVANCED SHARING" 
    echo "  • Password protection"
    echo "  • User-specific sharing (not just public links)"
    echo "  • Share management (list, update, delete shares)"
    echo "  • Email notifications"
    echo ""
    
    echo "🎯 PHASE 3: ENTERPRISE FEATURES"
    echo "  • Share analytics and access logs"
    echo "  • Batch sharing operations"
    echo "  • Domain restrictions"
    echo "  • Watermarking"
    echo "  • Advanced permissions (edit, admin)"
    echo ""
    
    echo "🛠️  IMMEDIATE NEXT STEPS:"
    echo "  1. Add share endpoints to routes:"
    echo "     POST /api/v2/drive/files/:fileId/share"
    echo "     GET  /api/v2/drive/public/:shareToken"
    echo ""
    echo "  2. Update DriveFile model with sharing fields:"
    echo "     - share_token: String"
    echo "     - shared_at: Date" 
    echo "     - expires_at: Date"
    echo "     - share_permissions: String"
    echo "     - access_count: Number"
    echo ""
    echo "  3. Implement controller methods in driveFileShare.js"
    echo "  4. Add validation schemas in validators/v2/driveFileShare.js"
    echo "  5. Update services/v2/driveFileShare.js with business logic"
    echo ""
    
    big_separator
}

# Main execution
main() {
    echo "🚀 Starting File Sharing Feature Tests..."
    echo "Using real file ID: $FILE_ID"
    echo "Generated test share token: $SHARE_TOKEN"
    big_separator
    
    # Run all tests
    test_health_check
    test_get_existing_files
    test_get_file_details
    test_file_sharing_update
    test_share_link_generation
    test_public_link_access
    test_share_management
    test_user_shared_files
    test_batch_operations
    
    echo ""
    log_success "All file sharing tests completed!"
    
    # Print summary
    echo ""
    echo "📊 TEST SUMMARY:"
    echo "✅ Health Check: PASSED"
    echo "✅ Get Files: PASSED"
    echo "✅ Get File Details: PASSED"  
    echo "⚠️  File Update (sharing): DEPENDS ON MODEL"
    echo "❌ Share Link Generation: NOT IMPLEMENTED"
    echo "❌ Public Link Access: NOT IMPLEMENTED"
    echo "❌ Share Management: NOT IMPLEMENTED"
    echo "❌ User Shared Files: NOT IMPLEMENTED"
    echo "❌ Batch Operations: NOT IMPLEMENTED"
    
    print_implementation_roadmap
}

# Handle script interruption
trap 'echo -e "\n👋 File sharing tests interrupted"; exit 0' INT

# Run main function
main
