import { memo, SyntheticEvent, useCallback, useEffect, useRef, useState } from "react"

import { TabContext, TabPanel } from "@mui/lab"
import { Box, Divider, Drawer, Tab, Tabs } from "@mui/material"

import styles from "./Sidebar.module.css"
import { SidebarHeader } from "./SidebarHeader"
import { SidebarTabJobCommands } from "./SidebarTabJobCommands"
import { SidebarTabJobDetails } from "./SidebarTabJobDetails"
import { SidebarTabJobLogs } from "./SidebarTabJobLogs"
import { SidebarTabJobResult } from "./SidebarTabJobResult"
import { SidebarTabJobYaml } from "./SidebarTabJobYaml"
import { Job, JobState } from "../../../models/lookoutV2Models"
import { ICordonService } from "../../../services/lookoutV2/CordonService"
import { IGetJobInfoService } from "../../../services/lookoutV2/GetJobInfoService"
import { IGetRunInfoService } from "../../../services/lookoutV2/GetRunInfoService"
import { CommandSpec } from "../../../utils"

enum SidebarTab {
  JobDetails = "JobDetails",
  JobResult = "JobResult",
  Yaml = "Yaml",
  Logs = "Logs",
  Commands = "Commands",
}

type ResizeState = {
  isResizing: boolean
  startX: number
  currentX: number
}

export interface SidebarProps {
  job: Job
  runInfoService: IGetRunInfoService
  jobSpecService: IGetJobInfoService
  cordonService: ICordonService
  sidebarWidth: number
  commandSpecs: CommandSpec[]
  onClose: () => void
  onWidthChange: (width: number) => void
}

export const Sidebar = memo(
  ({
    job,
    runInfoService,
    jobSpecService,
    cordonService,
    sidebarWidth,
    onClose,
    onWidthChange,
    commandSpecs,
  }: SidebarProps) => {
    const [openTab, setOpenTab] = useState<SidebarTab>(SidebarTab.JobDetails)

    const handleTabChange = useCallback((_: SyntheticEvent, newValue: SidebarTab) => {
      setOpenTab(newValue)
    }, [])

    // Logic to keep the sidebar the correct height while accounting for possible page headers
    const ref = useRef<HTMLDivElement>(null)
    const [visibleHeightAboveElement, setVisibleHeightAboveElement] = useState(0)
    useEffect(() => {
      const onScroll = () => {
        if (ref.current !== null) {
          setVisibleHeightAboveElement(ref.current.offsetTop - window.scrollY)
        }
      }

      // Calculate on first load
      onScroll()

      // Recalculate on every scroll
      window.addEventListener("scroll", onScroll)
      return () => {
        window.removeEventListener("scroll", onScroll)
      }
    }, [ref])

    // Hack: setting `isResizing` state field does not seem to work well with mousedown/mousemove listeners,
    // so we use a ref here instead. Note that the state is still needed to trigger re-renders
    const resizeRef = useRef(false)
    const [resizeState, setResizeState] = useState<ResizeState>({
      isResizing: false,
      startX: 0,
      currentX: 0,
    })
    const handleMouseDown = useCallback((x: number) => {
      resizeRef.current = true
      setResizeState({
        isResizing: true,
        startX: x,
        currentX: x,
      })
    }, [])
    const handleMouseMove = useCallback((x: number) => {
      if (!resizeRef.current) {
        return
      }
      setResizeState({
        ...resizeState,
        currentX: x,
      })
      const offsetRight = document.body.offsetWidth - (x - document.body.offsetLeft)
      const minWidth = 350
      const maxWidth = 1920
      if (offsetRight > minWidth && offsetRight < maxWidth) {
        onWidthChange(offsetRight)
      }
    }, [])
    const handleMouseUp = useCallback(() => {
      resizeRef.current = false
      setResizeState({
        ...resizeState,
        isResizing: false,
      })
    }, [])

    useEffect(() => {
      const mousemove = (e: MouseEvent) => {
        handleMouseMove(e.clientX)
      }
      document.addEventListener("mousemove", mousemove)
      document.addEventListener("mouseup", handleMouseUp)
      return () => {
        document.removeEventListener("mousemove", mousemove)
        document.removeEventListener("mouseup", handleMouseUp)
      }
    }, [])

    const resizerClasses = (resizeRef.current ? [styles.resizer, styles.isResizing] : [styles.resizer]).join(" ")
    return (
      <Drawer
        id="resizable"
        ref={ref}
        anchor="right"
        variant="permanent"
        role="complementary"
        sx={{
          position: "sticky",
          top: 0,
          height: `calc(100vh - ${visibleHeightAboveElement}px)`,
          width: sidebarWidth,
          minWidth: "350px",
        }}
        // Child element
        PaperProps={{
          sx: {
            width: "100%",
            position: "initial",
          },
        }}
        open={true}
      >
        <div className={styles.sidebarContainer}>
          <div onMouseDown={(e) => handleMouseDown(e.clientX)} id="dragger" className={resizerClasses} />
          <Box className={styles.sidebarContent}>
            <SidebarHeader job={job} onClose={onClose} className={styles.sidebarHeader} />
            <Divider />
            <div className={styles.sidebarTabContext}>
              <TabContext value={openTab}>
                <Tabs value={openTab} onChange={handleTabChange} className={styles.sidebarTabs}>
                  <Tab label="Details" value={SidebarTab.JobDetails} sx={{ minWidth: "50px" }}></Tab>
                  <Tab label="Result" value={SidebarTab.JobResult} sx={{ minWidth: "50px" }}></Tab>
                  <Tab label="Yaml" value={SidebarTab.Yaml} sx={{ minWidth: "50px" }}></Tab>
                  <Tab
                    label="Logs"
                    value={SidebarTab.Logs}
                    sx={{ minWidth: "50px" }}
                    disabled={job.state === JobState.Queued}
                  ></Tab>
                  <Tab
                    label="Commands"
                    value={SidebarTab.Commands}
                    sx={{ minWidth: "50px" }}
                    disabled={job.state === JobState.Queued}
                  ></Tab>
                </Tabs>

                <TabPanel value={SidebarTab.JobDetails} className={styles.sidebarTabPanel}>
                  <SidebarTabJobDetails key={job.jobId} job={job} />
                </TabPanel>

                <TabPanel value={SidebarTab.JobResult} className={styles.sidebarTabPanel}>
                  <SidebarTabJobResult
                    key={job.jobId}
                    job={job}
                    jobInfoService={jobSpecService}
                    runInfoService={runInfoService}
                    cordonService={cordonService}
                  />
                </TabPanel>

                <TabPanel value={SidebarTab.Yaml} className={styles.sidebarTabPanel}>
                  <SidebarTabJobYaml key={job.jobId} job={job} />
                </TabPanel>

                <TabPanel value={SidebarTab.Logs} className={styles.sidebarTabPanel}>
                  <SidebarTabJobLogs key={job.jobId} job={job} />
                </TabPanel>

                <TabPanel value={SidebarTab.Commands} className={styles.sidebarTabPanel}>
                  <SidebarTabJobCommands key={job.jobId} job={job} commandSpecs={commandSpecs} />
                </TabPanel>
              </TabContext>
            </div>
          </Box>
        </div>
      </Drawer>
    )
  },
)
