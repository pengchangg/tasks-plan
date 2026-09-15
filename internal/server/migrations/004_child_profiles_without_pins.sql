-- The child end is the default view of the app and is reached without a
-- credential, so children no longer carry a PIN.
ALTER TABLE children DROP COLUMN pin_hash;
