using System.Runtime.InteropServices;
using System.Runtime;
using SqlSyncAgent.Options;

namespace SqlSyncAgent;

/// <summary>
/// Limita o uso de memória do processo via Windows Job Object.
/// Garante que o agente não consuma mais que MaxPercentOfTotalRam da RAM física,
/// preservando memória para o SQL Server espelho e o restante do sistema.
///
/// Quando o processo excede o limite, o Windows o termina (o serviço é reiniciado
/// automaticamente pelo SCM, e o próximo ciclo retoma a sincronização).
/// </summary>
public static class MemoryGuard
{
    public static void Apply(MemoryOptions opts, ILogger log)
    {
        try
        {
            // 1. Configura o GC para ser mais agressivo na devolução de memória ao SO.
            //    Isso reduz o working set entre ciclos, sem afetar throughput perceptível
            //    em uma carga I/O-bound como a nossa (leitura SQL + HTTP).
            try
            {
                GCSettings.LatencyMode = GCLatencyMode.Interactive;
            }
            catch { /* ignora em modos não suportados */ }

            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                log.LogInformation("MemoryGuard: SO não-Windows, limite por Job Object não aplicado.");
                return;
            }

            var totalRam = GetTotalPhysicalMemoryBytes();
            if (totalRam == 0)
            {
                log.LogWarning("MemoryGuard: não foi possível detectar RAM total, limite não aplicado.");
                return;
            }

            var pct = Math.Clamp(opts.MaxPercentOfTotalRam, 10, 90);
            var limitBytes = (ulong)(totalRam * (double)pct / 100.0);

            // Garante um piso de 256 MB e um teto razoável.
            if (limitBytes < 256UL * 1024 * 1024) limitBytes = 256UL * 1024 * 1024;

            log.LogInformation(
                "MemoryGuard: RAM total={TotalMB} MB, limite do agente={LimitMB} MB ({Pct}%).",
                totalRam / (1024 * 1024), limitBytes / (1024 * 1024), pct);

            ApplyJobObjectLimit(limitBytes, log);
        }
        catch (Exception ex)
        {
            log.LogError(ex, "MemoryGuard: falha ao aplicar limite de memória");
        }
    }

    private static ulong GetTotalPhysicalMemoryBytes()
    {
        var status = new MEMORYSTATUSEX();
        status.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
        if (GlobalMemoryStatusEx(ref status))
        {
            return status.ullTotalPhys;
        }
        return 0;
    }

    private static void ApplyJobObjectLimit(ulong limitBytes, ILogger log)
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            log.LogWarning("MemoryGuard: CreateJobObject falhou (err={Err})", Marshal.GetLastWin32Error());
            return;
        }

        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_JOB_MEMORY |
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        info.JobMemoryLimit = (UIntPtr)limitBytes;

        var length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        var ptr = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)length))
            {
                log.LogWarning("MemoryGuard: SetInformationJobObject falhou (err={Err})", Marshal.GetLastWin32Error());
                return;
            }

            var current = GetCurrentProcess();
            if (!AssignProcessToJobObject(job, current))
            {
                log.LogWarning("MemoryGuard: AssignProcessToJobObject falhou (err={Err}). Já pode estar em outro Job.",
                    Marshal.GetLastWin32Error());
                return;
            }

            log.LogInformation("MemoryGuard: limite aplicado via Job Object com sucesso.");
        }
        finally
        {
            Marshal.FreeHGlobal(ptr);
        }
    }

    // --- P/Invoke ---

    private const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr a, string? lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob, int infoType, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
}
