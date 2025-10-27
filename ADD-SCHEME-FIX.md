# Add Scheme Button Fix

## Issue
The "Add Scheme" button wasn't opening the form modal properly.

## Root Cause
The button was only calling `setShowFDSchemeForm(true)` without resetting the form state. This meant:
1. Form could have stale data if previously opened
2. Editing state wasn't cleared
3. Modal would show previous data or have issues

## Fix Applied
Changed the Add Scheme button to reset form and clear editing state before opening modal:

```javascript
onClick={() => {
  resetFDSchemeForm()  // Reset all form fields
  setEditingFDScheme(null)  // Clear editing state
  setShowFDSchemeForm(true)  // Open the modal
}}
```

## Also Fixed
- Added same fix to "Add Rate Slab" button
- Ensures clean form state every time

## Testing
1. Click "Add Scheme" button
2. Modal should open with empty form fields
3. Fill in and submit
4. Should create successfully
5. Edit button should open with pre-filled data
6. Cancel button should close modal and reset state

