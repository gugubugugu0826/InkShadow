use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::model_gateway::CommandError;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapacityMetric {
    status: &'static str,
    total_bytes: Option<u64>,
    available_bytes: Option<u64>,
    reason: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeModelCapacity {
    logical_cpu_count: usize,
    physical_memory: CapacityMetric,
    application_data_disk: CapacityMetric,
    gpu_memory: CapacityMetric,
}

#[tauri::command]
pub(crate) fn inspect_native_model_capacity(
    app: AppHandle,
) -> Result<NativeModelCapacity, CommandError> {
    let app_data_directory = app.path().app_data_dir().map_err(|_| {
        CommandError::new(
            "MODEL_CAPACITY_UNAVAILABLE",
            "The native capacity check could not resolve the application data volume.",
            true,
            vec!["RETRY"],
        )
    })?;
    Ok(inspect_capacity_for_path(&app_data_directory))
}

fn inspect_capacity_for_path(app_data_directory: &Path) -> NativeModelCapacity {
    NativeModelCapacity {
        logical_cpu_count: std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1),
        physical_memory: inspect_physical_memory(),
        application_data_disk: inspect_disk_capacity(app_data_directory),
        gpu_memory: unavailable_metric("gpu_capacity_not_measured"),
    }
}

fn measured_metric(total_bytes: u64, available_bytes: u64) -> CapacityMetric {
    if total_bytes == 0 || available_bytes > total_bytes {
        return unavailable_metric("invalid_platform_measurement");
    }
    CapacityMetric {
        status: "measured",
        total_bytes: Some(total_bytes),
        available_bytes: Some(available_bytes),
        reason: None,
    }
}

fn unavailable_metric(reason: &'static str) -> CapacityMetric {
    CapacityMetric {
        status: "unavailable",
        total_bytes: None,
        available_bytes: None,
        reason: Some(reason),
    }
}

#[cfg(windows)]
fn inspect_physical_memory() -> CapacityMetric {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    // SAFETY: MEMORYSTATUSEX is initialized to zero, dwLength is set to the
    // exact structure size required by GlobalMemoryStatusEx, and the pointer
    // remains valid for the duration of the call.
    let mut status: MEMORYSTATUSEX = unsafe { zeroed() };
    status.dwLength = size_of::<MEMORYSTATUSEX>() as u32;
    let succeeded = unsafe { GlobalMemoryStatusEx(&mut status) };
    if succeeded == 0 {
        unavailable_metric("physical_memory_query_failed")
    } else {
        measured_metric(status.ullTotalPhys, status.ullAvailPhys)
    }
}

#[cfg(not(windows))]
fn inspect_physical_memory() -> CapacityMetric {
    unavailable_metric("platform_capacity_not_implemented")
}

#[cfg(windows)]
fn inspect_disk_capacity(path: &Path) -> CapacityMetric {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let existing = path.ancestors().find(|candidate| candidate.exists());
    let Some(existing) = existing else {
        return unavailable_metric("application_data_volume_missing");
    };
    let wide_path = existing
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut available = 0_u64;
    let mut total = 0_u64;
    let mut total_free = 0_u64;
    // SAFETY: wide_path is a valid NUL-terminated UTF-16 path and every output
    // pointer refers to a live u64 for the duration of the call.
    let succeeded = unsafe {
        GetDiskFreeSpaceExW(
            wide_path.as_ptr(),
            &mut available,
            &mut total,
            &mut total_free,
        )
    };
    if succeeded == 0 {
        unavailable_metric("application_data_volume_query_failed")
    } else {
        measured_metric(total, available.min(total_free))
    }
}

#[cfg(not(windows))]
fn inspect_disk_capacity(_path: &Path) -> CapacityMetric {
    unavailable_metric("platform_capacity_not_implemented")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_inventory_never_invents_gpu_memory() {
        let capacity = inspect_capacity_for_path(Path::new(env!("CARGO_MANIFEST_DIR")));

        assert!(capacity.logical_cpu_count >= 1);
        assert_eq!(
            capacity.gpu_memory,
            unavailable_metric("gpu_capacity_not_measured")
        );
    }

    #[cfg(windows)]
    #[test]
    fn reads_real_windows_memory_and_workspace_volume_capacity() {
        let capacity = inspect_capacity_for_path(Path::new(env!("CARGO_MANIFEST_DIR")));

        assert_eq!(capacity.physical_memory.status, "measured");
        assert!(capacity.physical_memory.total_bytes.unwrap_or_default() > 0);
        assert!(
            capacity.physical_memory.available_bytes.unwrap_or_default()
                <= capacity.physical_memory.total_bytes.unwrap_or_default()
        );
        assert_eq!(capacity.application_data_disk.status, "measured");
        assert!(
            capacity
                .application_data_disk
                .total_bytes
                .unwrap_or_default()
                > 0
        );
        assert!(
            capacity
                .application_data_disk
                .available_bytes
                .unwrap_or_default()
                <= capacity
                    .application_data_disk
                    .total_bytes
                    .unwrap_or_default()
        );
    }
}
