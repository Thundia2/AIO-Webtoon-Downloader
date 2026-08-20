package com.aio.downloader.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.aio.downloader.core.LogLevel
import com.aio.downloader.core.LogLine
import com.aio.downloader.core.LogTail
import com.aio.downloader.ui.components.AioButton
import com.aio.downloader.ui.components.AioCard
import com.aio.downloader.ui.components.ButtonTone
import com.aio.downloader.ui.components.Hairline
import com.aio.downloader.ui.components.HelpText
import com.aio.downloader.ui.theme.AioMotion
import com.aio.downloader.ui.theme.AioText
import com.aio.downloader.ui.theme.aio

/**
 * aio-dl.py's console output, classified and colour-coded.
 *
 * WHY THIS SCREEN EARNS ITS PLACE: the structured events drive the Queue card,
 * but they carry milestones only. The reasoning — which scanlation group won and
 * why, which CDN host got throttled, which pages were retried, what the
 * skipped-chapter report said — is printed and nothing else captures it. On a
 * phone there is no terminal to fall back to, so without this screen a failed
 * download is simply inexplicable.
 *
 * The lines arrive from [LogTail], already through the same strip/drop/classify
 * pipeline the desktop applies (`UI-source/electron/log-filter.js`).
 */
@Composable
fun LogsScreen(
    lines: List<LogLine>,
    error: String?,
    onClear: () -> Unit,
) {
    // The reader is only worth running while someone is looking. It follows
    // logcat from "now", so a download that ran while this screen was closed is
    // not retroactively visible — an accepted trade for not burning a thread
    // and a process on a screen nobody has open. `adb logcat` still has it all.
    DisposableEffect(Unit) {
        LogTail.start()
        onDispose { LogTail.stop() }
    }

    var levelFilter by rememberSaveable { mutableStateOf<String?>(null) }
    val filtered = remember(lines, levelFilter) {
        if (levelFilter == null) lines else lines.filter { it.level.name == levelFilter }
    }

    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    // "Following" means pinned within a few rows of the bottom. Once the user
    // scrolls up to read something, auto-scroll must stop — yanking the view
    // away mid-sentence is the classic log-viewer sin.
    val following by remember {
        derivedStateOf {
            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            last >= listState.layoutInfo.totalItemsCount - 3
        }
    }
    LaunchedEffect(filtered.size, following) {
        if (following && filtered.isNotEmpty()) {
            listState.scrollToItem(filtered.lastIndex)
        }
    }

    Column(Modifier.fillMaxSize()) {
        FilterBar(
            lines = lines,
            active = levelFilter,
            onSelect = { levelFilter = it },
            onClear = onClear,
        )
        Hairline()

        Box(Modifier.weight(1f)) {
            when {
                error != null -> ErrorState(error)
                filtered.isEmpty() -> EmptyState(hasLines = lines.isNotEmpty())
                else -> LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
                ) {
                    items(filtered, key = { it.id }) { line -> LogRow(line) }
                }
            }

            // Jump-to-bottom, shown only when it would actually do something —
            // i.e. when the user has scrolled up and auto-follow is suspended.
            JumpToLatest(
                visible = !following && filtered.isNotEmpty(),
                onClick = { scope.launch { listState.animateScrollToItem(filtered.lastIndex) } },
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(16.dp),
            )
        }
    }
}

/**
 * EXTRACTED RATHER THAN INLINED: inside the `Box` nested in this screen's
 * `Column`, `AnimatedVisibility` resolved to the `ColumnScope` overload while
 * only `BoxScope` was innermost — a compile error. Its own composable takes the
 * outer ColumnScope out of the resolution set. Same trick as AioApp's
 * BadgedIcon.
 */
@Composable
private fun JumpToLatest(visible: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    AnimatedVisibility(
        visible = visible,
        enter = AioMotion.revealEnter,
        exit = AioMotion.revealExit,
        modifier = modifier,
    ) {
        AioButton(
            text = "Latest",
            icon = Icons.Filled.ArrowDownward,
            compact = true,
            onClick = onClick,
        )
    }
}

@Composable
private fun LogRow(line: LogLine) {
    val status = MaterialTheme.aio
    val color = when (line.level) {
        LogLevel.Error -> MaterialTheme.colorScheme.error
        LogLevel.Warning -> status.warning
        LogLevel.Success -> status.success
        // Verbose is detail hanging off the line above it — dimmed rather than
        // hidden, because it is usually the answer when something looks wrong.
        LogLevel.Verbose -> status.mutedForeground.copy(alpha = 0.75f)
        LogLevel.Info -> MaterialTheme.colorScheme.onBackground.copy(alpha = 0.9f)
    }

    Row(Modifier.fillMaxWidth()) {
        // A 2px severity gutter instead of a coloured background: at this text
        // size a tinted row block would drown the text it is meant to mark, and
        // an error still has to be findable while scrolling fast.
        Box(
            Modifier
                .padding(top = 2.dp, bottom = 2.dp, end = 8.dp)
                .width(2.dp)
                .height(15.dp)
                .background(
                    if (line.level == LogLevel.Info || line.level == LogLevel.Verbose) {
                        Color.Transparent
                    } else {
                        color
                    },
                ),
        )
        Text(
            text = line.text,
            style = AioText.log,
            color = color,
            // Horizontal scroll, not wrap: aio-dl.py aligns its output in
            // columns, and wrapping a 200-char line destroys that alignment for
            // every line around it.
            modifier = Modifier
                .weight(1f)
                .horizontalScroll(rememberScrollState()),
            softWrap = false,
        )
    }
}

// ── filter bar ─────────────────────────────────────────────────────────────

@Composable
private fun FilterBar(
    lines: List<LogLine>,
    active: String?,
    onSelect: (String?) -> Unit,
    onClear: () -> Unit,
) {
    val errors = remember(lines) { lines.count { it.level == LogLevel.Error } }
    val warnings = remember(lines) { lines.count { it.level == LogLevel.Warning } }

    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        FilterChip("All", lines.size, active == null) { onSelect(null) }
        FilterChip(
            "Errors",
            errors,
            active == LogLevel.Error.name,
            tint = MaterialTheme.colorScheme.error,
        ) {
            onSelect(if (active == LogLevel.Error.name) null else LogLevel.Error.name)
        }
        FilterChip(
            "Warnings",
            warnings,
            active == LogLevel.Warning.name,
            tint = MaterialTheme.aio.warning,
        ) {
            onSelect(if (active == LogLevel.Warning.name) null else LogLevel.Warning.name)
        }
        Spacer(Modifier.weight(1f))
        AioButton(text = "Clear", tone = ButtonTone.Ghost, compact = true, onClick = onClear)
    }
}

@Composable
private fun FilterChip(
    label: String,
    count: Int,
    selected: Boolean,
    tint: Color? = null,
    onClick: () -> Unit,
) {
    val accent = tint ?: MaterialTheme.colorScheme.primary
    val fg = if (selected) accent else MaterialTheme.aio.mutedForeground
    Row(
        Modifier
            .clip(CircleShape)
            .background(if (selected) accent.copy(alpha = 0.12f) else Color.Transparent)
            .border(
                1.dp,
                if (selected) accent.copy(alpha = 0.35f) else MaterialTheme.aio.border,
                CircleShape,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 11.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = fg)
        if (count > 0) {
            Spacer(Modifier.width(5.dp))
            Text(count.toString(), style = AioText.numericSmall, color = fg.copy(alpha = 0.8f))
        }
    }
}

// ── empty / error ──────────────────────────────────────────────────────────

@Composable
private fun EmptyState(hasLines: Boolean) {
    Box(Modifier.fillMaxSize().padding(20.dp), contentAlignment = Alignment.Center) {
        AioCard(contentPadding = PaddingValues(24.dp)) {
            Column(
                Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Box(
                    Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.10f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Filled.Terminal,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(19.dp),
                    )
                }
                Spacer(Modifier.height(12.dp))
                Text(
                    if (hasLines) "Nothing matches that filter" else "No output yet",
                    style = MaterialTheme.typography.titleSmall,
                )
                Spacer(Modifier.height(4.dp))
                HelpText(
                    if (hasLines) {
                        "Tap the chip again to see everything."
                    } else {
                        "Output appears here once a download starts."
                    },
                )
            }
        }
    }
}

@Composable
private fun ErrorState(message: String) {
    Box(Modifier.fillMaxSize().padding(20.dp), contentAlignment = Alignment.Center) {
        AioCard(
            borderColor = MaterialTheme.colorScheme.error.copy(alpha = 0.3f),
            contentPadding = PaddingValues(20.dp),
        ) {
            Text("Log reader unavailable", style = MaterialTheme.typography.titleSmall)
            Spacer(Modifier.height(6.dp))
            HelpText(
                "$message\n\nThe download itself is unaffected — everything here is also " +
                    "in `adb logcat`.",
            )
        }
    }
}
