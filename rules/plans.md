# How to Create and Execute Plans

This rule outlines the standard process for creating structured plans (often in `.mdc` files) and executing them effectively using checkboxes for progress tracking.

## Creating a Plan

When asked to create a plan, follow this structure:

1.  **Goal Definition:** Start with a clear, concise goal statement in bold.
2.  **Breakdown into Major Steps:** Use numbered list items for the main phases or components of the work.
3.  **Detailed Sub-steps:** Use bullet points (`*` or `-`) under each numbered step for specific actions, file modifications, or checks.
4.  **Checkboxes:** Prepend **ALL** numbered steps AND bullet points with markdown checkboxes (`[ ] `) to allow for tracking progress.
5.  **Key Considerations:** Add a final section in bold (`**Key Considerations:**`) listing potential issues, requirements, or important factors, also using bullet points with checkboxes (`[ ] `).

## Executing a Plan

When executing a plan documented in an `.mdc` file:

- Read the plan carefully before starting.
- As each numbered step or bullet point task is completed successfully, mark its checkbox as done by changing `[ ]` to `[x]`.
- If a step needs to be skipped or becomes irrelevant, mark it as done (`[x]`) and add a brief inline note explaining why (e.g., `[x] Step xyz (Skipped because...)`).
- If the plan needs modification during execution (e.g., adding or changing steps), update the `.mdc` file accordingly, ensuring new steps also have checkboxes.

