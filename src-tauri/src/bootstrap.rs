use std::{
    env,
    ffi::{OsStr, OsString},
    fs, io,
    net::IpAddr,
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    sync::Arc,
    time::Duration,
};

use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    process::{Child, ChildStdin, Command},
};

pub(crate) const BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(600);
pub(crate) const MAX_BOOTSTRAP_SCRIPT_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_CAPTURE_BYTES_PER_STREAM: usize = 512 * 1024;
pub(crate) const MAX_LOG_LINE_BYTES: usize = 8 * 1024;
pub(crate) const MAX_LOG_LINES_PER_STREAM: usize = 2_000;

const WINDOWS_KNOWN_HOSTS_OPTION: &str = "UserKnownHostsFile=pihub_known_hosts";

// Only this fixed loader is placed on the remote command line. The generated
// bootstrap script is carried in a length-prefixed stdin frame. Signed Server
// assets are fetched and verified on the remote host by the embedded script.
const WINDOWS_BOOTSTRAP_LOADER: &str = r#"$ErrorActionPreference='Stop'
$stream=[Console]::OpenStandardInput()
$reader=[IO.BinaryReader]::new($stream,[Text.Encoding]::UTF8,$true)
$scriptLength=[uint64]$reader.ReadUInt64()
if($scriptLength -eq 0 -or $scriptLength -gt 1048576){throw 'invalid bootstrap script length'}
$scriptBytes=$reader.ReadBytes([int]$scriptLength)
if($scriptBytes.Length -ne [int]$scriptLength){throw 'truncated bootstrap script'}
if($stream.ReadByte() -ne -1){throw 'unexpected trailing bootstrap data'}
$utf8=[Text.UTF8Encoding]::new($false,$true)
$block=[ScriptBlock]::Create($utf8.GetString($scriptBytes))
& $block"#;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[allow(dead_code)] // Other variants are live when this same source is built on those targets.
pub(crate) enum LocalPlatform {
    Macos,
    Linux,
    Windows,
}

impl LocalPlatform {
    pub(crate) const fn current() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self::Macos
        }
        #[cfg(target_os = "linux")]
        {
            Self::Linux
        }
        #[cfg(target_os = "windows")]
        {
            Self::Windows
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        compile_error!("PiHub bootstrap supports only macOS, Linux, and Windows");
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct DiscoveryEnvironment {
    pub(crate) path_dirs: Vec<PathBuf>,
    pub(crate) program_files: Option<PathBuf>,
    pub(crate) program_w6432: Option<PathBuf>,
    pub(crate) local_app_data: Option<PathBuf>,
    pub(crate) system_root: Option<PathBuf>,
}

impl DiscoveryEnvironment {
    pub(crate) fn from_process() -> Self {
        Self {
            path_dirs: env::var_os("PATH")
                .map(|value| env::split_paths(&value).collect())
                .unwrap_or_default(),
            program_files: env::var_os("ProgramFiles").map(PathBuf::from),
            program_w6432: env::var_os("ProgramW6432").map(PathBuf::from),
            local_app_data: env::var_os("LOCALAPPDATA").map(PathBuf::from),
            system_root: env::var_os("SystemRoot")
                .or_else(|| env::var_os("WINDIR"))
                .map(PathBuf::from),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LocalExecutable {
    pub(crate) path: PathBuf,
    pub(crate) force_tailscale_argv0: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ExecutableSearch {
    trusted_candidates: Vec<PathBuf>,
    path_dirs: Vec<PathBuf>,
    path_names: Vec<&'static str>,
}

fn tailscale_search(
    platform: LocalPlatform,
    environment: &DiscoveryEnvironment,
) -> ExecutableSearch {
    let mut trusted_candidates = Vec::new();
    let path_names = match platform {
        LocalPlatform::Macos => {
            trusted_candidates.extend([
                PathBuf::from("/usr/local/bin/tailscale"),
                PathBuf::from("/opt/homebrew/bin/tailscale"),
                PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale"),
            ]);
            vec!["tailscale"]
        }
        LocalPlatform::Linux => {
            trusted_candidates.extend([
                PathBuf::from("/usr/bin/tailscale"),
                PathBuf::from("/usr/local/bin/tailscale"),
                PathBuf::from("/snap/bin/tailscale"),
            ]);
            vec!["tailscale"]
        }
        LocalPlatform::Windows => {
            for root in [
                environment.program_w6432.as_ref(),
                environment.program_files.as_ref(),
                environment.local_app_data.as_ref(),
            ]
            .into_iter()
            .flatten()
            {
                trusted_candidates.push(root.join("Tailscale").join("tailscale.exe"));
            }
            vec!["tailscale.exe"]
        }
    };
    ExecutableSearch {
        trusted_candidates,
        path_dirs: environment.path_dirs.clone(),
        path_names,
    }
}

fn ssh_search(platform: LocalPlatform, environment: &DiscoveryEnvironment) -> ExecutableSearch {
    let mut trusted_candidates = Vec::new();
    let path_names = match platform {
        LocalPlatform::Macos => {
            trusted_candidates.extend([
                PathBuf::from("/usr/bin/ssh"),
                PathBuf::from("/usr/local/bin/ssh"),
            ]);
            vec!["ssh"]
        }
        LocalPlatform::Linux => {
            trusted_candidates.extend([
                PathBuf::from("/usr/bin/ssh"),
                PathBuf::from("/bin/ssh"),
                PathBuf::from("/usr/local/bin/ssh"),
            ]);
            vec!["ssh"]
        }
        LocalPlatform::Windows => {
            if let Some(root) = environment.system_root.as_ref() {
                trusted_candidates.push(root.join("System32").join("OpenSSH").join("ssh.exe"));
                trusted_candidates.push(root.join("Sysnative").join("OpenSSH").join("ssh.exe"));
            }
            vec!["ssh.exe"]
        }
    };
    ExecutableSearch {
        trusted_candidates,
        path_dirs: environment.path_dirs.clone(),
        path_names,
    }
}

fn find_executable_by(
    search: &ExecutableSearch,
    is_executable: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    search
        .trusted_candidates
        .iter()
        .cloned()
        .chain(search.path_dirs.iter().flat_map(|directory| {
            search
                .path_names
                .iter()
                .map(move |name| directory.join(name))
        }))
        .find(|path| is_executable(path))
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(windows)]
    {
        true
    }
}

pub(crate) fn discover_tailscale_executable_with(
    platform: LocalPlatform,
    environment: &DiscoveryEnvironment,
) -> Option<LocalExecutable> {
    let path = find_executable_by(&tailscale_search(platform, environment), executable_file)?;
    let force_tailscale_argv0 =
        platform == LocalPlatform::Macos && path.file_name() == Some(OsStr::new("Tailscale"));
    Some(LocalExecutable {
        path,
        force_tailscale_argv0,
    })
}

pub(crate) fn discover_ssh_executable_with(
    platform: LocalPlatform,
    environment: &DiscoveryEnvironment,
) -> Option<LocalExecutable> {
    let path = find_executable_by(&ssh_search(platform, environment), executable_file)?;
    Some(LocalExecutable {
        path,
        force_tailscale_argv0: false,
    })
}

pub(crate) fn discover_tailscale_executable() -> Option<LocalExecutable> {
    discover_tailscale_executable_with(
        LocalPlatform::current(),
        &DiscoveryEnvironment::from_process(),
    )
}

pub(crate) fn discover_ssh_executable() -> Option<LocalExecutable> {
    discover_ssh_executable_with(
        LocalPlatform::current(),
        &DiscoveryEnvironment::from_process(),
    )
}

pub(crate) fn normalize_tailscale_host(value: &str) -> Result<String, String> {
    if value.is_empty()
        || value != value.trim()
        || value.len() > 255
        || value.chars().any(char::is_control)
    {
        return Err("Tailscale 主机名为空、过长或包含非法空白".into());
    }

    let unwrapped = match (value.strip_prefix('['), value.strip_suffix(']')) {
        (Some(without_open), Some(_)) => without_open
            .strip_suffix(']')
            .ok_or("IPv6 地址括号不匹配")?,
        (None, None) => value,
        _ => return Err("IPv6 地址括号不匹配".into()),
    };
    if let Ok(ip) = unwrapped.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(address) => {
                let octets = address.octets();
                if octets[0] == 100 && (64..=127).contains(&octets[1]) {
                    Ok(address.to_string())
                } else {
                    Err("IPv4 地址不在 Tailscale 100.64.0.0/10 网段".into())
                }
            }
            IpAddr::V6(address) => {
                let segments = address.segments();
                if segments[..3] == [0xfd7a, 0x115c, 0xa1e0] {
                    Ok(address.to_string())
                } else {
                    Err("IPv6 地址不在 Tailscale ULA 网段".into())
                }
            }
        };
    }
    if unwrapped != value {
        return Err("只有 IPv6 地址可以使用方括号".into());
    }

    let hostname = value.strip_suffix('.').unwrap_or(value);
    if hostname.is_empty()
        || hostname.ends_with('.')
        || hostname.len() > 253
        || !hostname.is_ascii()
    {
        return Err("MagicDNS 主机名格式无效".into());
    }
    let normalized = hostname.to_ascii_lowercase();
    if !normalized.ends_with(".ts.net") {
        return Err("只允许 Tailscale MagicDNS (.ts.net) 主机名".into());
    }
    for label in normalized.split('.') {
        let bytes = label.as_bytes();
        if bytes.is_empty()
            || bytes.len() > 63
            || !bytes.first().is_some_and(u8::is_ascii_alphanumeric)
            || !bytes.last().is_some_and(u8::is_ascii_alphanumeric)
            || !bytes
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
        {
            return Err("MagicDNS 标签只能使用字母、数字和内部横线".into());
        }
    }
    Ok(normalized)
}

pub(crate) fn normalize_ssh_username(
    value: &str,
    allow_windows_domain: bool,
) -> Result<String, String> {
    if value.is_empty()
        || value != value.trim()
        || value.len() > 128
        || value.chars().any(char::is_control)
    {
        return Err("SSH 用户名为空、过长或包含非法空白".into());
    }
    let parts: Vec<&str> = value.split('\\').collect();
    if (!allow_windows_domain && parts.len() != 1) || parts.len() > 2 {
        return Err("SSH 用户名包含非法域分隔符".into());
    }
    for (index, part) in parts.iter().enumerate() {
        if allow_windows_domain && index == 0 && *part == "." {
            continue;
        }
        let bytes = part.as_bytes();
        if bytes.is_empty()
            || !bytes.first().is_some_and(u8::is_ascii_alphanumeric)
            || !bytes.last().is_some_and(u8::is_ascii_alphanumeric)
            || !bytes
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'-' | b'_'))
        {
            return Err(
                "SSH 用户名只能使用字母、数字、点、横线和下划线，且首尾必须为字母或数字".into(),
            );
        }
    }
    Ok(value.to_owned())
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let bits = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        output.push(ALPHABET[((bits >> 18) & 63) as usize] as char);
        output.push(ALPHABET[((bits >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[((bits >> 6) & 63) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(bits & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}

pub(crate) fn windows_loader_encoded_command() -> String {
    let utf16_le: Vec<u8> = WINDOWS_BOOTSTRAP_LOADER
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    base64_encode(&utf16_le)
}

pub(crate) fn windows_ssh_args(username: &str, host: &str) -> Result<Vec<OsString>, String> {
    let username = normalize_ssh_username(username, true)?;
    let host = normalize_tailscale_host(host)?;
    let encoded_loader = windows_loader_encoded_command();
    let args = [
        "-T",
        "-F",
        "none",
        "-o",
        "BatchMode=yes",
        "-o",
        "PasswordAuthentication=no",
        "-o",
        "KbdInteractiveAuthentication=no",
        "-o",
        "PreferredAuthentications=publickey",
        "-o",
        "ConnectTimeout=12",
        "-o",
        "ConnectionAttempts=1",
        "-o",
        "ServerAliveInterval=10",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "GlobalKnownHostsFile=none",
        "-o",
        WINDOWS_KNOWN_HOSTS_OPTION,
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ForwardX11=no",
        "-l",
        username.as_str(),
        "--",
        host.as_str(),
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encoded_loader.as_str(),
    ];
    Ok(args.into_iter().map(OsString::from).collect())
}

fn windows_frame_header(script_len: usize) -> io::Result<[u8; 8]> {
    if script_len == 0 || script_len > MAX_BOOTSTRAP_SCRIPT_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "bootstrap script length is invalid",
        ));
    }
    let mut header = [0u8; 8];
    header.copy_from_slice(&(script_len as u64).to_le_bytes());
    Ok(header)
}

pub(crate) async fn write_windows_bootstrap_frame<W>(
    writer: &mut W,
    script: &[u8],
) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let header = windows_frame_header(script.len())?;
    writer.write_all(&header).await?;
    writer.write_all(script).await?;
    writer.shutdown().await
}

#[derive(Debug)]
pub(crate) enum BootstrapStdin {
    Raw(Vec<u8>),
    WindowsFrame { script: String },
}

impl BootstrapStdin {
    async fn write_to(self, mut writer: ChildStdin) -> io::Result<()> {
        match self {
            Self::Raw(bytes) => {
                writer.write_all(&bytes).await?;
                writer.shutdown().await
            }
            Self::WindowsFrame { script } => {
                write_windows_bootstrap_frame(&mut writer, script.as_bytes()).await
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ProcessLimits {
    pub(crate) total_timeout: Duration,
    pub(crate) capture_bytes_per_stream: usize,
    pub(crate) log_line_bytes: usize,
    pub(crate) log_lines_per_stream: usize,
}

impl Default for ProcessLimits {
    fn default() -> Self {
        Self {
            total_timeout: BOOTSTRAP_TIMEOUT,
            capture_bytes_per_stream: MAX_CAPTURE_BYTES_PER_STREAM,
            log_line_bytes: MAX_LOG_LINE_BYTES,
            log_lines_per_stream: MAX_LOG_LINES_PER_STREAM,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BootstrapLogLine {
    pub(crate) stream: &'static str,
    pub(crate) line: String,
}

#[derive(Debug)]
pub(crate) struct BoundedCommand {
    pub(crate) executable: LocalExecutable,
    pub(crate) args: Vec<OsString>,
    pub(crate) current_dir: Option<PathBuf>,
    pub(crate) stdin: BootstrapStdin,
}

#[derive(Debug)]
pub(crate) struct BoundedOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr_truncated: bool,
    pub(crate) input_error: Option<String>,
}

#[derive(Debug)]
struct CapturedStream {
    bytes: Vec<u8>,
    truncated: bool,
}

async fn pump_stream<R, F>(
    mut reader: R,
    stream: &'static str,
    limits: ProcessLimits,
    emit: Arc<F>,
) -> io::Result<CapturedStream>
where
    R: AsyncRead + Unpin,
    F: Fn(BootstrapLogLine) + Send + Sync + 'static,
{
    let mut captured = Vec::with_capacity(limits.capture_bytes_per_stream.min(64 * 1024));
    let mut captured_truncated = false;
    let mut pending = Vec::with_capacity(limits.log_line_bytes.min(1024));
    let mut line_truncated = false;
    let mut emitted_lines = 0usize;
    let mut chunk = [0u8; 8192];

    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        let available = limits
            .capture_bytes_per_stream
            .saturating_sub(captured.len());
        let retained = available.min(read);
        captured.extend_from_slice(&chunk[..retained]);
        captured_truncated |= retained < read;

        if emitted_lines >= limits.log_lines_per_stream {
            continue;
        }
        for byte in &chunk[..read] {
            if *byte == b'\n' {
                if emitted_lines < limits.log_lines_per_stream
                    && (!pending.is_empty() || line_truncated)
                {
                    if pending.last() == Some(&b'\r') {
                        pending.pop();
                    }
                    let mut line = String::from_utf8_lossy(&pending).into_owned();
                    if line_truncated {
                        line.push_str(" ...[line truncated]");
                    }
                    emit(BootstrapLogLine { stream, line });
                    emitted_lines += 1;
                }
                pending.clear();
                line_truncated = false;
            } else if pending.len() < limits.log_line_bytes {
                pending.push(*byte);
            } else {
                line_truncated = true;
            }
        }
    }

    if emitted_lines < limits.log_lines_per_stream && (!pending.is_empty() || line_truncated) {
        if pending.last() == Some(&b'\r') {
            pending.pop();
        }
        let mut line = String::from_utf8_lossy(&pending).into_owned();
        if line_truncated {
            line.push_str(" ...[line truncated]");
        }
        emit(BootstrapLogLine { stream, line });
        emitted_lines += 1;
    }
    if captured_truncated && emitted_lines < limits.log_lines_per_stream {
        emit(BootstrapLogLine {
            stream,
            line: format!(
                "[pihub] {stream} output truncated at {} bytes",
                limits.capture_bytes_per_stream
            ),
        });
    }
    Ok(CapturedStream {
        bytes: captured,
        truncated: captured_truncated,
    })
}

#[cfg(unix)]
fn configure_executable(command: &mut Command, executable: &LocalExecutable) {
    if executable.force_tailscale_argv0 {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().arg0("tailscale");
    }
}

#[cfg(windows)]
fn configure_executable(_command: &mut Command, _executable: &LocalExecutable) {}

fn configure_process_tree(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP;
        command
            .as_std_mut()
            .creation_flags(CREATE_NEW_PROCESS_GROUP);
    }
}

#[cfg(unix)]
#[derive(Debug)]
struct ProcessTree {
    process_group: libc::pid_t,
}

#[cfg(unix)]
impl ProcessTree {
    fn attach(child: &Child) -> io::Result<Self> {
        let process_id = child
            .id()
            .filter(|id| *id <= libc::pid_t::MAX as u32)
            .ok_or_else(|| io::Error::other("child process has no valid process id"))?;
        Ok(Self {
            process_group: process_id as libc::pid_t,
        })
    }

    fn signal(&self, signal: libc::c_int) -> io::Result<()> {
        let result = unsafe { libc::killpg(self.process_group, signal) };
        if result == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(error)
        }
    }
}

#[cfg(windows)]
#[derive(Debug)]
struct ProcessTree {
    job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
unsafe impl Send for ProcessTree {}

#[cfg(windows)]
unsafe impl Sync for ProcessTree {}

#[cfg(windows)]
impl ProcessTree {
    fn attach(child: &Child) -> io::Result<Self> {
        use std::{mem::size_of, ptr};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let tree = Self { job };
        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                tree.job,
                JobObjectExtendedLimitInformation,
                ptr::addr_of!(information).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(io::Error::last_os_error());
        }
        let process = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("child process has no process handle"))?;
        if unsafe { AssignProcessToJobObject(tree.job, process) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(tree)
    }

    fn terminate(&self) -> io::Result<()> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;

        if unsafe { TerminateJobObject(self.job, 1460) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            CloseHandle(self.job);
        }
    }
}

#[cfg(unix)]
async fn terminate_process_tree(child: &mut Child, tree: &ProcessTree) -> io::Result<()> {
    if child.try_wait()?.is_some() {
        return Ok(());
    }
    tree.signal(libc::SIGTERM)?;
    match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
        Ok(result) => return result.map(|_| ()),
        Err(_) => tree.signal(libc::SIGKILL)?,
    }
    tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "process tree did not exit"))??;
    Ok(())
}

#[cfg(windows)]
async fn terminate_process_tree(child: &mut Child, tree: &ProcessTree) -> io::Result<()> {
    if child.try_wait()?.is_some() {
        return Ok(());
    }
    let terminate_result = tree.terminate();
    if terminate_result.is_err() {
        let _ = child.start_kill();
    }
    tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "process tree did not exit"))??;
    terminate_result
}

async fn kill_after_setup_error(child: &mut Child, tree: Option<&ProcessTree>) {
    if let Some(tree) = tree {
        let _ = terminate_process_tree(child, tree).await;
    } else {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

pub(crate) async fn run_bounded_command<F>(
    specification: BoundedCommand,
    limits: ProcessLimits,
    emit: F,
) -> io::Result<BoundedOutput>
where
    F: Fn(BootstrapLogLine) + Send + Sync + 'static,
{
    if limits.capture_bytes_per_stream == 0
        || limits.log_line_bytes == 0
        || limits.log_lines_per_stream == 0
        || limits.total_timeout.is_zero()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "process limits must be non-zero",
        ));
    }

    let BoundedCommand {
        executable,
        args,
        current_dir,
        stdin,
    } = specification;
    let mut command = Command::new(&executable.path);
    configure_executable(&mut command, &executable);
    configure_process_tree(&mut command);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(directory) = current_dir {
        command.current_dir(directory);
    }

    let mut child = command.spawn()?;
    let tree = match ProcessTree::attach(&child) {
        Ok(tree) => tree,
        Err(error) => {
            kill_after_setup_error(&mut child, None).await;
            return Err(error);
        }
    };
    let child_stdin = match child.stdin.take() {
        Some(value) => value,
        None => {
            kill_after_setup_error(&mut child, Some(&tree)).await;
            return Err(io::Error::other("failed to open child stdin"));
        }
    };
    let child_stdout = match child.stdout.take() {
        Some(value) => value,
        None => {
            kill_after_setup_error(&mut child, Some(&tree)).await;
            return Err(io::Error::other("failed to open child stdout"));
        }
    };
    let child_stderr = match child.stderr.take() {
        Some(value) => value,
        None => {
            kill_after_setup_error(&mut child, Some(&tree)).await;
            return Err(io::Error::other("failed to open child stderr"));
        }
    };

    let emit = Arc::new(emit);
    let operation = async {
        let (input_result, stdout_result, stderr_result, status_result) = tokio::join!(
            stdin.write_to(child_stdin),
            pump_stream(child_stdout, "stdout", limits, Arc::clone(&emit)),
            pump_stream(child_stderr, "stderr", limits, Arc::clone(&emit)),
            child.wait(),
        );
        let status = status_result?;
        let stdout = stdout_result?;
        let stderr = stderr_result?;
        let input_error = input_result.err().map(|error| error.to_string());
        if status.success() {
            if let Some(error) = input_error.as_ref() {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    format!("bootstrap stdin failed: {error}"),
                ));
            }
        }
        Ok(BoundedOutput {
            status,
            stdout: stdout.bytes,
            stderr: stderr.bytes,
            stdout_truncated: stdout.truncated,
            stderr_truncated: stderr.truncated,
            input_error,
        })
    };

    match tokio::time::timeout(limits.total_timeout, operation).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => {
            let _ = terminate_process_tree(&mut child, &tree).await;
            Err(error)
        }
        Err(_) => {
            let termination = terminate_process_tree(&mut child, &tree).await;
            if let Err(error) = termination {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("bootstrap timed out and process cleanup failed: {error}"),
                ));
            }
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "bootstrap exceeded the 600 second time limit",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn strict_tailnet_host_normalization() {
        assert_eq!(
            normalize_tailscale_host("Node-1.Example.ts.net.").unwrap(),
            "node-1.example.ts.net"
        );
        assert_eq!(
            normalize_tailscale_host("[fd7a:115c:a1e0::1]").unwrap(),
            "fd7a:115c:a1e0::1"
        );
        assert_eq!(
            normalize_tailscale_host("100.64.0.1").unwrap(),
            "100.64.0.1"
        );
        for rejected in [
            " node.example.ts.net",
            "-node.example.ts.net",
            "node..example.ts.net",
            "node_.example.ts.net",
            "node.example.com",
            "100.63.255.255",
            "100.128.0.1",
            "[node.example.ts.net]",
            "node.example.ts.net..",
            "node.example.ts.net\n",
        ] {
            assert!(
                normalize_tailscale_host(rejected).is_err(),
                "accepted {rejected:?}"
            );
        }
    }

    #[test]
    fn strict_username_validation() {
        for accepted in ["Administrator", "domain\\user.name", ".\\local-user"] {
            assert_eq!(normalize_ssh_username(accepted, true).unwrap(), accepted);
        }
        for rejected in [
            "-user",
            "user-",
            "user@host",
            "domain\\\\user",
            "domain\\-user",
            "user/name",
            " user",
            "user\n",
        ] {
            assert!(
                normalize_ssh_username(rejected, true).is_err(),
                "accepted {rejected:?}"
            );
        }
        assert!(normalize_ssh_username("domain\\user", false).is_err());
    }

    #[test]
    fn executable_search_has_deterministic_precedence() {
        let search = ExecutableSearch {
            trusted_candidates: vec![PathBuf::from("/trusted/first")],
            path_dirs: vec![PathBuf::from("/path/one"), PathBuf::from("/path/two")],
            path_names: vec!["tool", "tool.exe"],
        };
        let selected = find_executable_by(&search, |path| {
            path == Path::new("/trusted/first") || path == Path::new("/path/one/tool")
        });
        assert_eq!(selected, Some(PathBuf::from("/trusted/first")));

        let selected = find_executable_by(&search, |path| path == Path::new("/path/two/tool.exe"));
        assert_eq!(selected, Some(PathBuf::from("/path/two/tool.exe")));
    }

    #[test]
    fn platform_candidate_generation_is_complete() {
        let environment = DiscoveryEnvironment {
            path_dirs: vec![PathBuf::from("/custom/bin")],
            program_files: Some(PathBuf::from("C:/Program Files")),
            program_w6432: Some(PathBuf::from("C:/ProgramW6432")),
            local_app_data: Some(PathBuf::from("C:/Users/Test/AppData/Local")),
            system_root: Some(PathBuf::from("C:/Windows")),
        };
        let tailscale = tailscale_search(LocalPlatform::Windows, &environment);
        assert!(tailscale
            .trusted_candidates
            .contains(&PathBuf::from("C:/Program Files/Tailscale/tailscale.exe")));
        assert_eq!(tailscale.path_names, vec!["tailscale.exe"]);

        let ssh = ssh_search(LocalPlatform::Windows, &environment);
        assert!(ssh
            .trusted_candidates
            .contains(&PathBuf::from("C:/Windows/System32/OpenSSH/ssh.exe")));
        assert_eq!(ssh.path_names, vec!["ssh.exe"]);
    }

    #[test]
    fn windows_ssh_argv_is_structured_and_short() {
        let args = windows_ssh_args("domain\\user", "Node.Example.ts.net").unwrap();
        let args: Vec<String> = args
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        let login = args.iter().position(|value| value == "-l").unwrap();
        assert_eq!(args[login + 1], "domain\\user");
        assert_eq!(args[login + 2], "--");
        assert_eq!(args[login + 3], "node.example.ts.net");
        assert!(args.contains(&"BatchMode=yes".to_owned()));
        assert!(args.contains(&"StrictHostKeyChecking=accept-new".to_owned()));
        assert!(args.contains(&WINDOWS_KNOWN_HOSTS_OPTION.to_owned()));
        let encoded = args.last().unwrap();
        assert_eq!(args[args.len() - 2], "-EncodedCommand");
        assert!(encoded.len() < 4096, "loader length={}", encoded.len());
        assert!(!encoded.contains("pihub-server.tgz"));
        assert!(args.iter().all(|value| !value.contains("@latest")));
    }

    #[tokio::test]
    async fn windows_frame_has_exact_little_endian_length() {
        let script = b"Write-Output ok";
        let mut framed = Vec::new();
        write_windows_bootstrap_frame(&mut framed, script)
            .await
            .unwrap();
        assert_eq!(
            u64::from_le_bytes(framed[..8].try_into().unwrap()),
            script.len() as u64
        );
        assert_eq!(&framed[8..], script);
        assert!(write_windows_bootstrap_frame(&mut Vec::new(), b"")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn stream_pump_caps_transcript_and_long_lines() {
        let bytes = vec![b'x'; 256];
        let events = Arc::new(Mutex::new(Vec::new()));
        let target = Arc::clone(&events);
        let limits = ProcessLimits {
            total_timeout: Duration::from_secs(1),
            capture_bytes_per_stream: 32,
            log_line_bytes: 16,
            log_lines_per_stream: 4,
        };
        let captured = pump_stream(
            bytes.as_slice(),
            "stdout",
            limits,
            Arc::new(move |event| {
                target.lock().unwrap().push(event);
            }),
        )
        .await
        .unwrap();
        assert_eq!(captured.bytes.len(), 32);
        assert!(captured.truncated);
        let events = events.lock().unwrap();
        assert!(events.len() <= 4);
        assert!(events
            .iter()
            .any(|event| event.line.contains("line truncated")));
        assert!(events
            .iter()
            .any(|event| event.line.contains("output truncated")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bounded_command_streams_input_stdout_and_stderr() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let target = Arc::clone(&events);
        let output = run_bounded_command(
            BoundedCommand {
                executable: LocalExecutable {
                    path: PathBuf::from("/bin/sh"),
                    force_tailscale_argv0: false,
                },
                args: ["-c", "IFS= read -r value; printf 'out:%s\\n' \"$value\"; printf 'err:%s\\n' \"$value\" >&2"]
                    .into_iter()
                    .map(OsString::from)
                    .collect(),
                current_dir: None,
                stdin: BootstrapStdin::Raw(b"hello\n".to_vec()),
            },
            ProcessLimits {
                total_timeout: Duration::from_secs(3),
                ..ProcessLimits::default()
            },
            move |event| target.lock().unwrap().push(event),
        )
        .await
        .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), "out:hello\n");
        assert_eq!(String::from_utf8(output.stderr).unwrap(), "err:hello\n");
        let events = events.lock().unwrap();
        assert!(events
            .iter()
            .any(|event| event.stream == "stdout" && event.line == "out:hello"));
        assert!(events
            .iter()
            .any(|event| event.stream == "stderr" && event.line == "err:hello"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bounded_command_times_out_and_terminates_its_process_group() {
        let started = std::time::Instant::now();
        let error = run_bounded_command(
            BoundedCommand {
                executable: LocalExecutable {
                    path: PathBuf::from("/bin/sh"),
                    force_tailscale_argv0: false,
                },
                args: ["-c", "sleep 30 & wait"]
                    .into_iter()
                    .map(OsString::from)
                    .collect(),
                current_dir: None,
                stdin: BootstrapStdin::Raw(Vec::new()),
            },
            ProcessLimits {
                total_timeout: Duration::from_millis(100),
                ..ProcessLimits::default()
            },
            |_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
