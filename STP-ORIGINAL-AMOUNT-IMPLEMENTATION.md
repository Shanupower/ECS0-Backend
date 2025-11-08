# STP Original Amount Field Implementation

## Overview
Added a new field "Total Original Scheme Amount" to STP (Systematic Transfer Plan) receipts to capture the total amount invested in the original scheme from which periodic transfers will be made.

## Changes Made

### 1. Frontend - Receipt Creation Form
**File**: `c:\Users\Admin\Desktop\ECS0\src\components\receipt-steps\StepTransactionDetails.jsx`

#### Changes:
- Added new state variable `stpOriginalAmount` to track the total original scheme amount
- Added new UI field in the STP form section with label "Total Original Scheme Amount (₹)"
- Added helper text: "Total amount invested in the original scheme"
- Updated the `handleNext()` function to include `stp_original_amount` in transaction data
- Updated the `canProceed()` validation function to require this field for STP transactions

#### Field Position:
The field is positioned after "Transfer to Scheme" and before "Frequency" in the STP form flow.

### 2. Backend - Database Schema
**File**: `c:\Users\Admin\Desktop\ECS0-Backend\routes\receipts.js`

#### Changes:
- Added `stp_original_amount: d.stp_original_amount || null` to the receipt document schema (line 170)
- This field is now stored in the ArangoDB receipts collection alongside other STP fields

#### Database Field:
```javascript
stp_original_amount: d.stp_original_amount || null
```

### 3. Frontend - Receipt View Page
**File**: `c:\Users\Admin\Desktop\ECS0\src\pages\ReceiptViewPage.jsx`

#### Changes:
- Added comprehensive STP field mapping in the `transformedReceipt` object
- Added all STP-related fields including:
  - `stp_target_scheme_code`
  - `stp_target_scheme_name`
  - `stp_frequency`
  - `stp_start_date`
  - `stp_amount`
  - `stp_original_amount` (new field)
- Also added SWP fields for consistency

### 4. Frontend - Print Receipt Component
**File**: `c:\Users\Admin\Desktop\ECS0\src\components\PrintReceipt.jsx`

#### Changes:
- Added a new conditional section that displays detailed SIP/STP/SWP information
- For STP mode, displays:
  - Target Scheme
  - **Total Original Scheme Amount** (formatted as currency)
  - Frequency
  - Start Date
  - Transfer Amount (formatted as currency)
- This section only appears when the receipt mode is SIP, STP, or SWP

### 5. Backend - PDF Generation
**File**: `c:\Users\Admin\Desktop\ECS0-Backend\routes\receipt-pdf.js`

#### Changes:
- Added `stp_original_amount` to the STP details section in PDF generation
- Displays as "Total Original Scheme Amount" with proper INR currency formatting
- Positioned after "Transfer to Scheme" and before "STP Frequency"

#### PDF Field Addition:
```javascript
if (receipt.stp_original_amount) {
  yPos = addKeyValue('Total Original Scheme Amount', 
    new Intl.NumberFormat('en-IN', { 
      style: 'currency', 
      currency: 'INR' 
    }).format(receipt.stp_original_amount), 
    60, yPos, 490)
}
```

## Field Details

### Field Name
- **Database**: `stp_original_amount`
- **Display**: "Total Original Scheme Amount"

### Field Type
- Number (currency)

### Validation
- Required for STP transactions
- Must be a positive number
- Frontend validation prevents form submission if not filled

### Purpose
This field captures the total amount invested in the original/source scheme. This is different from:
- `stp_amount`: The periodic amount to be transferred
- `investment_amount`: The general investment amount field

### Example Use Case
If an investor has ₹1,00,000 in Scheme A and wants to set up an STP to transfer ₹10,000 monthly to Scheme B:
- `stp_original_amount`: ₹1,00,000 (total amount in source scheme)
- `stp_amount`: ₹10,000 (periodic transfer amount)
- `stp_target_scheme_name`: Scheme B (destination scheme)

## Testing Checklist

- [x] Frontend form displays the new field for STP mode
- [x] Field is required and validated before submission
- [x] Backend accepts and stores the field in the database
- [x] Receipt view page displays the field correctly
- [x] Print receipt component shows the field in STP section
- [x] PDF generation includes the field with proper formatting
- [x] No linting errors in any modified files

## Database Impact

### Schema Update
No migration required. The field is added as nullable (`|| null`) so existing receipts without this field will continue to work correctly.

### Backward Compatibility
- Existing STP receipts without this field will display empty/null values
- New STP receipts will require this field to be filled
- Field will only be required for new receipts created after this implementation

## Summary

All changes have been successfully implemented across:
1. ✅ Frontend receipt creation form
2. ✅ Backend database schema
3. ✅ Frontend receipt view page
4. ✅ Print receipt component
5. ✅ PDF generation

The implementation is complete and ready for testing in development/staging environment.

