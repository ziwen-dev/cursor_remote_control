Option Explicit
Dim shell, fs, root, node, server
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName))
If WScript.Arguments.Count <> 1 Then WScript.Quit 2
node = WScript.Arguments(0)
server = fs.BuildPath(root, "src\server.js")
shell.CurrentDirectory = root
WScript.Quit shell.Run(Chr(34) & node & Chr(34) & " " & Chr(34) & server & Chr(34), 0, True)
