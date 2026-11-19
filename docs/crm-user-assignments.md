# CRM analytics assignment sources

As of 19 November 2026, CRM analytics derives primary and secondary names from
`opportunities.data.primaryAssigneeUser` and `secondaryAssigneeUser`, checking that
each relation matches its corresponding Workspace Member ID. It does not read
Twenty's retired `assignedTo` or `secondaryAssignee` dropdowns.

Existing report columns (`primary_assignees`, `secondary_assignee`) and the masked
view's `assigned_to` alias remain compatible. The latter projects the primary
member's full name as a JSON array; the raw mirror's similarly named compatibility
column contains user IDs. Consumers should use the views or the new relation IDs.

Both assignments participate in `internal_assignee_emails`, maintained by
CRM-Automations. Repeated assignment to the same user counts once. Stage history
continues to show the current assignment and is not rewritten by this migration.

The live cutover updated only the CRM masking function and two views, preserving
existing ownership, read grants and contact masking. Existing deployment scripts
include these definitions for subsequent installs. Verification compares all rows,
checks that raw client contacts remain masked, and confirms reader isolation.
