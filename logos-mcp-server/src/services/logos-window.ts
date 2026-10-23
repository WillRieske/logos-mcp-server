// Finds the Logos main window for the Windows PowerShell helpers (I16).
//
// Process.MainWindowHandle is whichever visible, unowned top-level window
// .NET meets first. On 2026-10-19 a Logos hover popup (untitled, UIA class
// "Popup") took that place, so the word-study tool searched the popup for
// tabs, the foreground check failed and window state read the popup.
// Instead every top-level window of every Logos or Verbum process is listed,
// and the largest titled, unowned, non-tool window is taken as the main one.

/**
 * PowerShell that defines `Get-LogosWindows`, `Select-LogosWindows` and
 * `Find-LogosMainWindow`. Paste it after a script's `param` block and
 * UTF8_SETUP; it uses no backtick, so it can sit in a String.raw template.
 * Each window is an object with Handle, ProcessId, Title, Visible, Owned,
 * ToolWindow and Area; Area is the restored size, so a minimized main window
 * still wins over a small one.
 */
export const LOGOS_WINDOW_FINDER = String.raw`Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class LogosMcpWindow {
  public IntPtr Handle; public uint ProcessId; public string Title; public bool Visible; public bool Owned; public bool ToolWindow; public long Area;
}
public static class LogosMcpWindows {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr hWnd, ref PLACEMENT p);
  [StructLayout(LayoutKind.Sequential)] struct PLACEMENT { public int length, flags, showCmd, minX, minY, maxX, maxY, left, top, right, bottom; }
  // Top-level windows of the given processes, in Z order.
  public static LogosMcpWindow[] Of(uint[] pids) {
    List<LogosMcpWindow> found = new List<LogosMcpWindow>();
    HashSet<uint> wanted = new HashSet<uint>(pids);
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (!wanted.Contains(pid)) return true;
      LogosMcpWindow w = new LogosMcpWindow();
      w.Handle = h;
      w.ProcessId = pid;
      StringBuilder text = new StringBuilder(GetWindowTextLength(h) + 1);
      GetWindowText(h, text, text.Capacity);
      w.Title = text.ToString();
      w.Visible = IsWindowVisible(h);
      w.Owned = GetWindow(h, 4) != IntPtr.Zero;
      // GWL_EXSTYLE (-20) & WS_EX_TOOLWINDOW (0x80): popups and tooltips.
      w.ToolWindow = (GetWindowLongPtr(h, -20).ToInt64() & 0x80) != 0;
      PLACEMENT p = new PLACEMENT();
      p.length = Marshal.SizeOf(typeof(PLACEMENT));
      if (GetWindowPlacement(h, ref p)) w.Area = (long)Math.Max(0, p.right - p.left) * Math.Max(0, p.bottom - p.top);
      found.Add(w);
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
}
'@
function Get-LogosWindows {
  $ids = @(Get-Process -Name Logos, Verbum -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  if ($ids.Count -eq 0) { return @() }
  return @([LogosMcpWindows]::Of([uint32[]]$ids))
}
# >>> main window choice (run by tests/logos-window.test.ts with made-up windows)
# Main-window candidates, largest first: visible, titled, unowned and not a
# tool window. A hover popup is untitled (I16); menus, tooltips and dialogs
# are tool windows or owned.
function Select-LogosWindows($windows) {
  return @($windows | Where-Object { $_.Visible -and $_.Title -and -not $_.Owned -and -not $_.ToolWindow } | Sort-Object -Property @{ Expression = { [long]$_.Area }; Descending = $true })
}
# <<< main window choice
function Find-LogosMainWindow {
  $candidates = Select-LogosWindows (Get-LogosWindows)
  if ($candidates.Count -eq 0) { return $null }
  return $candidates[0]
}`;
