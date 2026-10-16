# Pair Management System - User Guide

## Overview

The Machine Configuration page has been completely redesigned with a **two-tab interface** for better organization and functionality.

## UI Layout

### Header
```
MACHINE CONFIGURATION     [🔄 Refresh]
```

### Tabs
```
┌─────────────────────────────────────────────────────┐
│ PAIR MANAGEMENT |  MACHINE FLEET             │
└─────────────────────────────────────────────────────┘
```

---

## Tab 1: Pair Management 📋

### What You See

```
┌─────────────────────────────────────────────────────┐
│                                                       │
│  Pairs (3)                    [+ Add Pair]           │
│                                                       │
│  ┌───────────────────────────────────────────────┐  │
│  │ ▼  Pair 1 (pair_1)                   3 machines │  │
│  │    [✏ Edit]  [🗑 Delete]                       │  │
│  │                                                  │  │
│  │    Machine List:                                │  │
│  │    ┌──────────────────────────────────────────┐ │  │
│  │    │ Machine     Type    Make/Model  Loc  Sta │ │  │
│  │    │ CNC-001     CNC     Fanuc       Bay 1 ▶ │ │  │
│  │    │ CNC-002     CNC     Mazak       Bay 2 ⏸ │ │  │
│  │    │ CNC-003     VMC     HURON       Bay 3 ⚠ │ │  │
│  │    │    [✏] [🗑]  [✏] [🗑]  [✏] [🗑]           │ │  │
│  │    └──────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────┘  │
│                                                       │
│  ┌───────────────────────────────────────────────┐  │
│  │ ▶  Pair 2 (pair_2)                   2 machines │  │
│  │    [✏ Edit]  [🗑 Delete]                       │  │
│  └───────────────────────────────────────────────┘  │
│                                                       │
│  ┌───────────────────────────────────────────────┐  │
│  │ ▶  Assembly Line A (assembly_line_a)  0 machines│  │
│  │    [✏ Edit]  [🗑 Delete]                       │  │
│  │    (Click expand arrow to see machines)         │  │
│  └───────────────────────────────────────────────┘  │
│                                                       │
└─────────────────────────────────────────────────────┘
```

### Add Pair Form

```
┌─────────────────────────────────────────────────────┐
│ ➕ Add New Pair                                    [✕] │
│                                                       │
│  Pair Name *              Display Name *             │
│  ┌──────────────────┐    ┌──────────────────┐       │
│  │ assembly_line_a  │    │ Assembly Line A   │       │
│  └──────────────────┘    └──────────────────┘       │
│                                                       │
│  ⚠ Name is immutable (cannot change after creation)│
│                                                       │
│  [✓ Add Pair]  [Cancel]                            │
│                                                       │
└─────────────────────────────────────────────────────┘
```

### Edit Pair Form

```
┌─────────────────────────────────────────────────────┐
│ ✏ Edit Pair                                        [✕] │
│                                                       │
│  Pair Name *              Display Name *             │
│  ┌──────────────────┐    ┌──────────────────┐       │
│  │ assembly_line_a  │    │ Assembly Line A   │       │
│  │ (DISABLED)       │    │                   │       │
│  └──────────────────┘    └──────────────────┘       │
│  ⚠ Name is immutable      Editable ✓              │
│                                                       │
│  [💾 Save Changes]  [Cancel]                        │
│                                                       │
└─────────────────────────────────────────────────────┘
```

### Key Features

✅ **Create pairs** - Unlimited (not limited to 1-8)
✅ **Rename display name** - Change "Pair 1" to "Assembly Line A"
✅ **Delete empty pairs** - Remove unused pairs
✅ **View machines per pair** - Expand to see all assigned machines
✅ **Inline machine edit** - Edit machines without leaving pair view
✅ **Machine counts** - See 3️⃣ machines badge at a glance

### Actions

| Action | Result | Error Handling |
|--------|--------|-----------------|
| Delete pair with 0 machines | Deleted successfully | ✅ Works |
| Delete pair with 3 machines | Error shown | ❌ "Cannot delete pair with 3 machine(s) assigned" |
| Create duplicate pair name | Error shown | ❌ "Pair name 'pair_1' already exists" |
| Edit machine from pair view | Opens machine form | ✅ Change any field |

---

## Tab 2: Machine Fleet 🏭

### What You See

```
┌─────────────────────────────────────────────────────┐
│                                                       │
│  Machine Fleet (5)                [+ Add Machine]    │
│                                                       │
│  ┌─────────────────────────────────────────────────┐│
│  │ Image │ Machine │ Pair  │ Type│ Make  │ Loc │ St││
│  ├─────────────────────────────────────────────────┤│
│  │       │ CNC-001 │ Pair 1│ CNC │ Fanuc │ Bay1│ ▶ ││
│  │ [🏭]  │ features...       │     │       │     │   ││
│  │       │ [✏ Edit] [🗑]                         │ ││
│  ├─────────────────────────────────────────────────┤│
│  │       │ CNC-002 │ Pair 1│ CNC │ Mazak │ Bay2│ ⏸ ││
│  │ [🏭]  │                 │     │       │     │   ││
│  │       │ [✏ Edit] [🗑]                         │ ││
│  ├─────────────────────────────────────────────────┤│
│  │ [🖼]  │ CNC-003 │ Asm-A │ VMC │ HURON │ Bay3│ ⚠ ││
│  │ image │ Live tooling... │     │       │     │   ││
│  │       │ [✏ Edit] [🗑]                         │ ││
│  └─────────────────────────────────────────────────┘│
│                                                       │
└─────────────────────────────────────────────────────┘
```

### Add Machine Form

```
┌─────────────────────────────────────────────────────┐
│ ➕ Add New Machine                                 [✕] │
│                                                       │
│  Machine Name *         Pair *         Machine Type *│
│  ┌──────────────────┐  ┌──────────────┐  ┌────────┐│
│  │ CNC-004          │  │ Select a pair│  │ CNC    ││
│  └──────────────────┘  │ ▼            │  └────────┘│
│                         │ Pair 1       │             │
│                         │ Pair 2       │             │
│                         │ Assembly Ln A│             │
│                         └──────────────┘             │
│                                                       │
│  Make / Brand           Model No       Tonnage      │
│  ┌──────────────────┐  ┌──────────────┐  ┌────────┐│
│  │ Fanuc            │  │ QT-200       │  │ 200T   ││
│  └──────────────────┘  └──────────────┘  └────────┘│
│                                                       │
│  Location / Line        Features (optional)          │
│  ┌──────────────────┐  ┌──────────────────────────┐│
│  │ Line A, Bay 2    │  │ Live tooling, Y-axis...  ││
│  └──────────────────┘  └──────────────────────────┘│
│                                                       │
│  MACHINE IMAGE                                       │
│  ┌──────────┐          [📷 Upload Image] [Remove] │
│  │ No image │          JPG, PNG, WebP — max 5MB  │
│  └──────────┘                                       │
│                                                       │
│  [✓ Add Machine]  [Cancel]                          │
│                                                       │
└─────────────────────────────────────────────────────┘
```

### Edit Machine Form

Same as Add form, but pre-filled with machine data. Image preview shows if image exists.

### Key Features

✅ **Dynamic Pair Dropdown** - Automatically populated from pairs you created
✅ **Machine Details** - Type, make, model, tonnage, location, features
✅ **Image Upload** - Upload machine photos for visual reference
✅ **Status Display** - Shows current machine status (running, idle, etc.)
✅ **Full CRUD** - Add, edit, delete machines
✅ **Form Validation** - Ensures pair is selected before saving

### Machine Status Legend

| Icon | Status | Color | Meaning |
|------|--------|-------|---------|
| ▶ | Running | Green (#10b981) | Machine is operating |
| ⏸ | Idle | Gray (#64748b) | Machine is not running |
| ⚠ | Breakdown | Red (#ef4444) | Machine has active breakdown |
| 🔧 | Setting Change | Orange (#f59e0b) | Model change in progress |

---

## Common Workflows

### Create a New Production Line

**Step 1:** Create the pair
- Go to **📋 Pair Management** tab
- Click **+ Add Pair**
- Enter Name: `line_b`
- Enter Display Name: `Production Line B`
- Click **✓ Add Pair**

**Step 2:** Add machines to the pair
- Go to **MACHINE FLEET** tab
- Click **+ Add Machine**
- Enter Machine Name: `CNC-005`
- Select Pair: `Production Line B`
- Enter other details...
- Click **✓ Add Machine**

**Step 3:** Verify
- Go back to **📋 Pair Management**
- Expand `Production Line B`
- Should see `CNC-005` listed with its details

### Reassign a Machine to Different Pair

**Step 1:** Find the machine
- Go to **MACHINE FLEET** tab
- Locate the machine you want to move

**Step 2:** Edit the machine
- Click **✏ Edit**
- Change the **Pair** dropdown to new pair
- Click **💾 Save Changes**

**Step 3:** Verify
- Machine now shows under new pair
- Old pair machine count decreased
- New pair machine count increased

### Delete a Pair (No Machines Assigned)

**Step 1:** Verify no machines
- Go to **📋 Pair Management**
- Check pair has **0 machines** badge

**Step 2:** Delete
- Click **🗑 Delete** button
- Click **OK** in confirmation
- Pair is removed from list

### Delete a Pair (With Machines)

**Step 1:** Attempt to delete
- Go to **📋 Pair Management**
- Click **🗑 Delete** on pair with machines
- Error message appears: ❌ "Cannot delete pair with 3 machine(s) assigned"

**Step 2:** Move machines
- **Option A:** Move machines to different pair
  - Click **✏ Edit** on machine in expanded view
  - Change pair in machine form
  - Machines reassigned, count updates
- **Option B:** Delete machines
  - Click **🗑** on each machine in expanded view
  - Confirm deletion
  - Once all machines removed, pair can be deleted

**Step 3:** Delete pair
- Now that pair has 0 machines
- Click **🗑 Delete**
- Pair is removed

---

## Error Messages You Might See

| Error | Cause | Solution |
|-------|-------|----------|
| ❌ Pair name 'pair_1' already exists | Duplicate name | Use a different name |
| ❌ Cannot delete pair with 3 machine(s) assigned | Pair not empty | Move/delete machines first |
| ❌ Pair is required | No pair selected | Select a pair from dropdown |
| ❌ Pair with id 5 not found | Invalid pair ID | Refresh and try again |
| ❌ Machine not found | Machine deleted | Refresh to see updated list |

---

## Data Shown Per Machine

### In Machine Fleet Table
- Machine name
- Assigned pair
- Machine type (CNC, VMC, etc.)
- Make/Brand
- Model number
- Tonnage/Spindle rating
- Location/Line
- Current status
- Edit & delete buttons

### In Pair Management (Expanded)
- Machine name
- Machine type
- Make/Model
- Location
- Current status
- Edit & delete buttons

---

## Tips & Tricks

💡 **Tip 1:** Pair names cannot be changed after creation
- Example: Can't rename "pair_1" to "pair_2"
- Workaround: Delete and recreate with new name (requires moving machines)

💡 **Tip 2:** Display names can be changed anytime
- "Pair 1" can be renamed to "Assembly Line A" later
- Changes immediately visible everywhere

💡 **Tip 3:** Machine count badges are real-time
- Creating a machine instantly updates count
- Deleting a machine instantly updates count
- Reassigning machine updates both pairs' counts

💡 **Tip 4:** Expand/collapse pairs with the arrow
- Click arrow (▶/▼) to see/hide machines for that pair
- Useful when you have many pairs to manage

💡 **Tip 5:** Edit machines from pair view
- No need to go to Machine Fleet tab
- Click ✏ on any machine in expanded view
- Makes pair management more efficient

---

## Keyboard Shortcuts

None currently implemented, but you can:
- Use Tab to navigate form fields
- Use Enter to submit forms
- Use Escape to close forms (future enhancement)

---

## Performance Notes

- Pair list loads instantly (database optimized)
- Machine dropdown populates dynamically from pairs
- Machine images are lazy-loaded when expanded
- Expanding pair shows machines with one API call

---

## Troubleshooting

**Q: I don't see any pairs**
- A: Create one first! Click "+ Add Pair" in Pair Management tab

**Q: Machine dropdown is empty**
- A: Create at least one pair first in Pair Management tab

**Q: I accidentally deleted a pair**
- A: Sorry, deletions are permanent. Contact administrator to restore from backup.

**Q: I can't rename a pair**
- A: Pair names are immutable by design. You can rename the Display Name instead.

**Q: Machine count shows wrong number**
- A: Try refreshing the page. If it still shows wrong, contact support.

---

## Future Features (Roadmap)

🚀 Coming soon:
- Bulk operations (move multiple machines at once)
- Pair templates with pre-configured settings
- Pair-level OEE dashboards
- Machine reassignment audit log
- Import/export pair configurations
- Pair performance analytics

---

## Support

For issues or questions:
1. Check this user guide
2. Review error messages carefully
3. Try refreshing the page
4. Contact system administrator

---

**Enjoy the new Pair Management System! 🎉**
