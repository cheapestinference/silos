// icons.ts — the icon dictionary: ONE concept = ONE glyph, across the whole web
// (no named menu, no new visible labels — the user discovers it; a tooltip
// on hover and little more). So the
// glyph has to mean the same thing everywhere, and every icon-only control
// says its name (and its shortcut, when it has one) in its `title`.
//
// Navigation components import their glyphs from HERE, by concept, never
// from lucide-react by drawing — so the next screen reuses a concept's glyph
// instead of inventing a second one, and a glyph already taken shows up as
// taken. Adding a concept = one line here, with a glyph no other line uses.
//
//   concept                          glyph (lucide)        where
//   ───────────────────────────────  ────────────────────  ─────────────────────────────
//   Home (pulse + Needs you)         House                 rail
//   Tasks (a task)                   ListChecks            task marks (no rail icon: the
//                                                          sidebar's switch is the door to the page)
//   Automations (an automation)      Zap ⚡                rail · agent row · «kept by» mark · Home rows
//   Files (the file explorer)        FolderTree            System › Files · explorer header
//   Project (a folder Silos runs)    Folder                project page · «Pick a project»
//   Vault (secrets)                  KeyRound              agent's vault zone (the page is System › Vault)
//   A silo (installed app)           Layers                rail slot · Home rows
//   Settings — the PLATFORM's only   Settings ⚙            sidebar footer. Nothing else wears ⚙.
//   An agent's settings (machinery)  SlidersHorizontal     context column's door to the agent's settings
//   Search everything (⌘K palette)   Search 🔍             sidebar header (the palette's door) · palette field
//   Filter this list (sidebar)       ListFilter            the sidebar's list filter, when one is set
//   New (start something)            Plus                  New menu · «new conversation» on an agent row · ⌘K «New task» · «Give it a task»
//   Row options (more)               MoreHorizontal ⋯      sidebar rows · automation page
//   The list (agents + convs, phone) PanelLeft             Home's list door · «back» from a page on a phone
//   Back (to where you came from)    ChevronLeft           chips, «‹ All», editors, task paging
//   Expand / collapse                ChevronRight / Down   agent and project carets, «N older»
//   Pin a conversation (to Pinned)   Pin                   row mark · unpin
//   Pin a project to the top         ArrowUpToLine         project page
//   The bag (parked projects)        Package               sidebar bag · «Put in bag»
//   Opened for a message (history)   Mail                  row mark
//   Real console (Claude in tmux)    SquareTerminal        mode switch · New console
//   Chat (SDK conversation)          MessageSquare         mode switch
//   New chat                         MessageSquarePlus     agent page
//   Shell (a plain terminal)         Terminal              terminal bar under the chat
//   Runs a command (no Claude)       Play                  automation row and page
//   Close                            X                     everywhere
//   Unlink a conversation from a task Unlink               ⌘K «Unlink this conversation from «…»»
//
// Reserved — NOT for navigation, because they already mean something else:
//   Archive  = archived (Settings › Archived agents, conversations a /clear
//              left behind). The bag is not archiving: it parks a live project.
//   Cog      = another gear; would read as Settings.
//   TerminalSquare = the SAME glyph as SquareTerminal (a lucide alias) — not
//              a distinct icon for anything.
export {
  House as HomeIcon,
  ListChecks as TasksIcon,
  Zap as AutomationIcon,
  FolderTree as FilesIcon,
  Folder as ProjectIcon,
  KeyRound as VaultIcon,
  Layers as SiloIcon,
  LifeBuoy as SiloHelpIcon,
  Receipt as SiloInvoiceIcon,
  FileText as SiloDocumentIcon,
  Users as SiloPeopleIcon,
  MonitorDot as SiloSystemIcon,
  Inbox as SiloInboxIcon,
  ListTodo as SiloTasksIcon,
  CalendarDays as SiloCalendarIcon,
  Settings as PlatformSettingsIcon,
  Search as SearchIcon,
  ListFilter as FilterIcon,
  Plus as NewIcon,
  MoreHorizontal as RowMenuIcon,
  PanelLeft as ListIcon,
  ChevronLeft as BackIcon,
  ChevronRight as ExpandIcon,
  ChevronDown as CollapseIcon,
  Pin as PinIcon,
  ArrowUpToLine as PinToTopIcon,
  Package as BagIcon,
  Mail as MessageIcon,
  SquareTerminal as ConsoleIcon,
  MessageSquare as ChatIcon,
  MessageSquarePlus as NewChatIcon,
  Terminal as ShellIcon,
  Play as CommandIcon,
  X as CloseIcon,
  Unlink as UnlinkIcon,
} from 'lucide-react'
