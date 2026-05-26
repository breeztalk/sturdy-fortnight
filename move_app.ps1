$lines = Get-Content 'index.html'
$appSection = $lines[1502..3941]
$newLines = $lines[0..55] + $appSection + $lines[56..1501] + $lines[3942..($lines.Count-1)]
$newLines | Set-Content 'index.html' -NoNewline
