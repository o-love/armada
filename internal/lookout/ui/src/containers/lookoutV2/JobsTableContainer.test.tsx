import { QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SnackbarProvider } from "notistack"
import { createMemoryRouter, RouterProvider } from "react-router-dom"
import { v4 as uuidv4 } from "uuid"

import { JobsTableContainer } from "./JobsTableContainer"
import { queryClient } from "../../App"
import { Job, JobState } from "../../models/lookoutV2Models"
import { FakeServicesProvider } from "../../services/fakeContext"
import { ICordonService } from "../../services/lookoutV2/CordonService"
import { IGetJobInfoService } from "../../services/lookoutV2/GetJobInfoService"
import { GetJobsResponse, IGetJobsService } from "../../services/lookoutV2/GetJobsService"
import { IGetRunInfoService } from "../../services/lookoutV2/GetRunInfoService"
import { IGroupJobsService } from "../../services/lookoutV2/GroupJobsService"
import { ILogService } from "../../services/lookoutV2/LogService"
import { UpdateJobSetsService } from "../../services/lookoutV2/UpdateJobSetsService"
import { UpdateJobsService } from "../../services/lookoutV2/UpdateJobsService"
import { FakeCordonService } from "../../services/lookoutV2/mocks/FakeCordonService"
import FakeGetJobInfoService from "../../services/lookoutV2/mocks/FakeGetJobInfoService"
import FakeGetJobsService from "../../services/lookoutV2/mocks/FakeGetJobsService"
import { FakeGetRunInfoService } from "../../services/lookoutV2/mocks/FakeGetRunInfoService"
import FakeGroupJobsService from "../../services/lookoutV2/mocks/FakeGroupJobsService"

const intersectionObserverMock = () => ({
  observe: () => null,
  disconnect: () => null,
})
window.IntersectionObserver = vi.fn().mockImplementation(intersectionObserverMock)

vi.setConfig({
  // This is quite a heavy component, and tests can timeout on a slower machine
  testTimeout: 30_000,
})

function makeTestJobs(
  n: number,
  queue: string,
  jobSet: string,
  state: JobState,
  annotations?: Record<string, string>,
): Job[] {
  const jobs: Job[] = []
  for (let i = 0; i < n; i++) {
    jobs.push({
      annotations: annotations ?? {},
      cpu: 1,
      ephemeralStorage: 8192,
      gpu: 8,
      jobId: uuidv4(),
      jobSet: jobSet,
      lastTransitionTime: new Date().toISOString(),
      memory: 8192,
      owner: queue,
      namespace: queue,
      priority: 1000,
      priorityClass: "armada-preemptible",
      queue: queue,
      runs: [],
      state: state,
      submitted: new Date().toISOString(),
    })
  }
  return jobs
}

describe("JobsTableContainer", () => {
  let getJobsService: IGetJobsService,
    groupJobsService: IGroupJobsService,
    runErrorService: IGetRunInfoService,
    jobSpecService: IGetJobInfoService,
    updateJobsService: UpdateJobsService

  beforeEach(() => {
    runErrorService = new FakeGetRunInfoService(false)
    jobSpecService = new FakeGetJobInfoService(false)

    localStorage.clear()

    updateJobsService = {
      cancelJobs: vi.fn(),
    } as any
  })

  const renderComponent = (
    fakeJobs: Job[] = [],
    search?: string,
    fakeServices: {
      v2GetJobsService?: IGetJobsService
      v2GroupJobsService?: IGroupJobsService
      v2RunInfoService?: IGetRunInfoService
      v2JobSpecService?: IGetJobInfoService
      v2LogService?: ILogService
      v2UpdateJobsService?: UpdateJobsService
      v2UpdateJobSetsService?: UpdateJobSetsService
      v2CordonService?: ICordonService
    } = {},
  ) => {
    getJobsService = new FakeGetJobsService(fakeJobs, false)
    groupJobsService = new FakeGroupJobsService(fakeJobs, false)
    const element = (
      <SnackbarProvider>
        <QueryClientProvider client={queryClient}>
          <FakeServicesProvider fakeJobs={fakeJobs} simulateApiWait={false} {...fakeServices}>
            <JobsTableContainer
              getJobsService={fakeServices.v2GetJobsService ?? getJobsService}
              groupJobsService={fakeServices.v2GroupJobsService ?? groupJobsService}
              updateJobsService={fakeServices.v2UpdateJobsService ?? updateJobsService}
              runInfoService={fakeServices.v2RunInfoService ?? runErrorService}
              jobSpecService={fakeServices.v2JobSpecService ?? jobSpecService}
              cordonService={fakeServices.v2CordonService ?? new FakeCordonService()}
              debug={false}
              autoRefreshMs={30000}
              commandSpecs={[]}
            />
          </FakeServicesProvider>
        </QueryClientProvider>
      </SnackbarProvider>
    )
    let initialEntry = "/v2"
    if (search !== undefined) {
      initialEntry += search
    }
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <>Navigated from Start</>,
        },
        {
          path: "/v2",
          element: element,
        },
      ],
      {
        initialEntries: [initialEntry],
        initialIndex: 0,
      },
    )

    const utils = render(<RouterProvider router={router} />)
    return { ...utils, router }
  }

  it("should render a spinner while loading initially", async () => {
    const fakeGetJobsService = new FakeGetJobsService([])
    fakeGetJobsService.getJobs = vi.fn(() => new Promise(() => undefined) as Promise<GetJobsResponse>)
    const { findAllByRole } = renderComponent([], undefined, {
      v2GetJobsService: fakeGetJobsService,
    })
    await findAllByRole("progressbar")
  })

  it("should handle no data", async () => {
    const { findByText } = renderComponent()
    await waitForFinishedLoading()

    await findByText("There is no data to display")
    await findByText("0–0 of 0")
  })

  it("should show the correct total row count on the first page", async () => {
    const { findByText } = renderComponent(
      makeTestJobs(60, "queue-1", "job-set-1", JobState.Queued),
      `?page=0&sort[id]=jobId&sort[desc]=false`,
    )
    await waitForFinishedLoading()
    await findByText("1–50 of more than 50")
  })

  it("should show the correct total row count on the last page", async () => {
    const { findByText } = renderComponent(
      makeTestJobs(60, "queue-1", "job-set-1", JobState.Queued),
      `?page=1&sort[id]=jobId&sort[desc]=false`,
    )
    await waitForFinishedLoading()
    await findByText("51–60 of 60")
  })

  describe("Grouping", () => {
    it.each([
      ["Job Set", "jobSet"],
      ["Queue", "queue"],
      ["State", "state"],
    ] as [string, keyof Job][])("should allow grouping by %s", async (displayString, groupKey) => {
      const jobs = [
        ...makeTestJobs(5, "queue-1", "job-set-1", JobState.Queued),
        ...makeTestJobs(10, "queue-2", "job-set-2", JobState.Pending),
        ...makeTestJobs(15, "queue-3", "job-set-3", JobState.Running),
      ]

      const numUniqueForJobKey = new Set(jobs.map((j) => j[groupKey])).size

      renderComponent(jobs)
      await waitForFinishedLoading()

      await groupByColumn(displayString)

      // Check number of rendered rows has changed
      await assertNumDataRowsShown(numUniqueForJobKey)

      // Expand a row
      const job = jobs[0]
      await expandRow(job[groupKey]!.toString())

      // Check the right number of rows is being shown
      const numShownJobs = jobs.filter((j) => j[groupKey] === job[groupKey]).length
      await assertNumDataRowsShown(numUniqueForJobKey + numShownJobs)
    })

    it("should allow 3 level grouping", async () => {
      const jobs = [
        ...makeTestJobs(5, "queue-1", "job-set-1", JobState.Queued),
        ...makeTestJobs(10, "queue-1", "job-set-1", JobState.Pending),
        ...makeTestJobs(15, "queue-1", "job-set-2", JobState.Running),
      ]

      renderComponent(jobs)

      // Group to 3 levels
      await groupByColumn("Queue")
      await groupByColumn("Job Set")
      await groupByColumn("State")

      await waitForFinishedLoading()
      await assertNumDataRowsShown(1)

      // Expand the first level
      await expandRow("queue-1")
      await assertNumDataRowsShown(1 + 2)

      // Expand the second level
      await expandRow("job-set-1")
      await assertNumDataRowsShown(1 + 2 + 2)

      // Expand the third level
      await expandRow(JobState.Queued)
      await assertNumDataRowsShown(1 + 2 + 2 + 5)
    })

    it("should reset currently-expanded if grouping changes", async () => {
      const jobs = [
        ...makeTestJobs(5, "queue-1", "job-set-1", JobState.Queued),
        ...makeTestJobs(10, "queue-1", "job-set-1", JobState.Pending),
        ...makeTestJobs(15, "queue-1", "job-set-2", JobState.Running),
      ]

      const { getByRole, queryAllByRole } = renderComponent(jobs)
      await waitForFinishedLoading()

      await groupByColumn("Queue")
      await assertNumDataRowsShown(1)

      // Expand a row
      await expandRow("queue-1")

      // Check the row right number of rows is being shown
      await assertNumDataRowsShown(1 + 30)

      // Assert arrow down icon is shown
      getByRole("button", { name: "Collapse row" })

      // Group by another header
      await groupByColumn("State")

      // Verify all rows are now collapsed
      await waitFor(() => expect(queryAllByRole("button", { name: "Collapse row" }).length).toBe(0))
    })
  })

  describe("Selecting", () => {
    it("should allow selecting rows", async () => {
      const jobs = [
        ...makeTestJobs(5, "queue-1", "job-set-1", JobState.Queued),
        ...makeTestJobs(10, "queue-2", "job-set-1", JobState.Pending),
        ...makeTestJobs(15, "queue-1", "job-set-2", JobState.Running),
      ]

      const { findByRole } = renderComponent(jobs)
      await waitForFinishedLoading()
      await groupByColumn("Queue")

      expect(await findByRole("button", { name: "Cancel selected" })).toBeDisabled()
      expect(await findByRole("button", { name: "Reprioritize selected" })).toBeDisabled()

      await toggleSelectedRow("queue", "queue-1")
      await toggleSelectedRow("queue", "queue-2")

      expect(await findByRole("button", { name: "Cancel selected" })).toBeEnabled()
      expect(await findByRole("button", { name: "Cancel selected" })).toBeEnabled()

      await toggleSelectedRow("queue", "queue-2")

      expect(await findByRole("button", { name: "Cancel selected" })).toBeEnabled()
      expect(await findByRole("button", { name: "Cancel selected" })).toBeEnabled()

      await toggleSelectedRow("queue", "queue-1")

      expect(await findByRole("button", { name: "Cancel selected" })).toBeDisabled()
      expect(await findByRole("button", { name: "Cancel selected" })).toBeDisabled()
    })
  })

  describe("Cancelling", () => {
    it("should pass individual jobs to cancel dialog", async () => {
      const jobs = [
        ...makeTestJobs(5, "queue-1", "job-set-1", JobState.Queued),
        ...makeTestJobs(10, "queue-2", "job-set-1", JobState.Pending),
        ...makeTestJobs(15, "queue-1", "job-set-2", JobState.Running),
      ]

      const { findByRole } = renderComponent(jobs)
      await waitForFinishedLoading()

      await toggleSelectedRow("jobId", jobs[0].jobId)

      await userEvent.click(await findByRole("button", { name: "Cancel selected" }))
      await findByRole("dialog", { name: "Cancel 1 job" }, { timeout: 2000 })
    })

    it("should pass groups to cancel dialog", async () => {
      const jobs = [
        ...makeTestJobs(500, "queue-1", "job-set-1", JobState.Queued),
        ...makeTestJobs(1000, "queue-1", "job-set-1", JobState.Pending),
        ...makeTestJobs(1500, "queue-1", "job-set-2", JobState.Running),
      ]

      const { findByRole } = renderComponent(jobs)
      await waitForFinishedLoading()
      await groupByColumn("Queue")

      // Wait for table to update
      await assertNumDataRowsShown(1)

      // Select a queue
      await toggleSelectedRow("queue", "queue-1")

      // Open the cancel dialog
      await userEvent.click(await findByRole("button", { name: "Cancel selected" }))

      // Check it retrieved the number of non-terminated jobs in this queue
      // Longer timeout as some fake API calls need to be made
      await findByRole("dialog", { name: `Cancel 3000 jobs` }, { timeout: 2000 })
    })
  })

  describe("Filtering", () => {
    it("should allow text filtering", async () => {
      const jobs = [
        ...makeTestJobs(5, "queue-1", "job-set-1", JobState.Queued),
        ...makeTestJobs(10, "queue-2", "job-set-1", JobState.Pending),
        ...makeTestJobs(15, "queue-1", "job-set-2", JobState.Running),
      ]

      renderComponent(jobs)
      await waitForFinishedLoading()
      await assertNumDataRowsShown(30)

      await filterTextColumnTo("Queue", "queue-2")
      await assertNumDataRowsShown(10)

      await filterTextColumnTo("Queue", "")

      await assertNumDataRowsShown(30)
    })

    it("should allow enum filtering", async () => {
      const jobs = [
        ...makeTestJobs(5, "queue-1", "job-set-1", JobState.Queued),
        ...makeTestJobs(10, "queue-2", "job-set-1", JobState.Pending),
        ...makeTestJobs(15, "queue-1", "job-set-2", JobState.Running),
      ]

      renderComponent(jobs)
      await clearAllGroupings()
      await waitForFinishedLoading()

      await assertNumDataRowsShown(30)

      await toggleEnumFilterOptions("State", ["Queued", "Pending"])
      await assertNumDataRowsShown(15)

      await toggleEnumFilterOptions("State", ["Queued", "Pending"])
      await assertNumDataRowsShown(30)
    })

    it("allows filtering on annotation columns", async () => {
      const jobs = [
        ...makeTestJobs(5, "queue-1", "job-set-1", JobState.Queued),
        ...makeTestJobs(10, "queue-2", "job-set-1", JobState.Pending),
        ...makeTestJobs(15, "queue-1", "job-set-2", JobState.Running, { hyperparameter: "some-test-hyperparameter" }),
      ]

      const { findAllByRole } = renderComponent(jobs)
      await clearAllGroupings()
      await waitForFinishedLoading()

      await addAnnotationColumn("hyperparameter")
      await assertNumDataRowsShown(30)

      await findAllByRole("cell", { name: "some-test-hyperparameter" })

      await filterTextColumnTo("hyperparameter", "some-test-hyperparameter")
      await assertNumDataRowsShown(15)
    })
  })

  describe("Sorting", () => {
    it("should allow sorting jobs", async () => {
      const jobs = [
        ...makeTestJobs(5, "queue-1", "job-set-1", JobState.Queued),
        ...makeTestJobs(10, "queue-2", "job-set-1", JobState.Pending),
        ...makeTestJobs(15, "queue-1", "job-set-2", JobState.Running),
      ]
      const sorted = [...jobs].sort((a, b) => {
        if (a.jobId < b.jobId) {
          return -1
        } else {
          return 1
        }
      })

      const { getAllByRole } = renderComponent(jobs)
      await waitForFinishedLoading()

      await toggleSorting("Job ID")

      await waitFor(() => {
        const rows = getAllByRole("row")
        // Skipping header and footer rows
        expect(rows[1]).toHaveTextContent(sorted[0].jobId) // Job ID
      })

      await toggleSorting("Job ID")

      await waitFor(() => {
        const rows = getAllByRole("row")
        // Order should be reversed now
        expect(rows[rows.length - 1]).toHaveTextContent(sorted[0].jobId)
      })
    })
  })

  describe("Refreshing data", () => {
    it("should allow refreshing data", async () => {
      const jobs = [
        ...makeTestJobs(5, "queue-1", "job-set-1", JobState.Queued),
        ...makeTestJobs(10, "queue-2", "job-set-1", JobState.Pending),
        ...makeTestJobs(15, "queue-1", "job-set-2", JobState.Running),
      ]
      const { findByRole } = renderComponent(jobs)
      await waitForFinishedLoading()
      await assertNumDataRowsShown(30)

      const firstRow = await findByRole("row", { name: new RegExp(jobs[0].jobId) })

      // Assert first job is not currently in Succeeded state
      expect(within(firstRow).queryByRole("cell", { name: "Succeeded" })).toBeNull()

      // Transition the job
      jobs[0].state = JobState.Succeeded

      // Refresh the data
      await triggerRefresh()
      await waitForFinishedLoading()

      // Assert its now showing in the Running state
      expect(within(firstRow).queryByRole("cell", { name: "Succeeded" })).not.toBeNull()
    })

    it("should maintain grouping and filtering state when refreshing", async () => {
      const jobs = [
        ...makeTestJobs(5, "queue-1", "job-set-1", JobState.Queued),
        ...makeTestJobs(10, "queue-2", "job-set-1", JobState.Pending),
        ...makeTestJobs(15, "queue-3", "job-set-2", JobState.Running),
      ]
      const { findByText } = renderComponent(jobs)
      await waitForFinishedLoading()

      // Applying grouping and filtering
      await groupByColumn("Queue")
      await filterTextColumnTo("Queue", "queue-2")

      // Check table is updated as expected
      await assertNumDataRowsShown(1)
      await findByText("queue-2")

      // Refresh the data
      await triggerRefresh()
      await waitForFinishedLoading()

      // Check table is in the same state
      await assertNumDataRowsShown(1)
      await findByText("queue-2")
    })
  })

  describe("Sidebar", () => {
    it("clicking job row should open sidebar", async () => {
      const jobs = [
        ...makeTestJobs(5, "queue-1", "job-set-1", JobState.Queued),
        ...makeTestJobs(10, "queue-2", "job-set-1", JobState.Pending),
        ...makeTestJobs(15, "queue-3", "job-set-2", JobState.Running),
      ]
      const { getByRole } = renderComponent(jobs)
      await waitForFinishedLoading()

      const firstJob = jobs[0]

      await clickOnJobRow(firstJob.jobId)

      const sidebar = getByRole("complementary")
      within(sidebar).getByText(firstJob.jobId)
    })

    it("clicking grouped row should not open", async () => {
      const jobs = [
        ...makeTestJobs(5, "queue-1", "job-set-1", JobState.Queued),
        ...makeTestJobs(10, "queue-2", "job-set-1", JobState.Pending),
        ...makeTestJobs(15, "queue-3", "job-set-2", JobState.Running),
      ]
      const { findByRole, queryByRole } = renderComponent(jobs)
      await waitForFinishedLoading()

      await groupByColumn("Queue")

      const firstRow = await findByRole("row", { name: new RegExp("queue-1") })
      await userEvent.click(within(firstRow).getByText(new RegExp("queue-1")))

      expect(queryByRole("complementary")).toBeNull()
    })
  })

  describe("Query Params", () => {
    it("should save table state to query params on load", async () => {
      const { router } = renderComponent()
      await waitForFinishedLoading()

      expect(router.state.location.search).toContain("page=0")
      expect(router.state.location.search).toContain("sort[id]=jobId&sort[desc]=true")
    })

    it("should save modifications to query params", async () => {
      const jobs = [
        ...makeTestJobs(5, "queue-1", "job-set-1", JobState.Queued),
        ...makeTestJobs(10, "queue-2", "job-set-1", JobState.Pending),
        ...makeTestJobs(15, "queue-3", "job-set-1", JobState.Running),
      ]
      const { router } = renderComponent(jobs)
      await waitForFinishedLoading()

      await groupByColumn("Job Set")

      await filterTextColumnTo("Job Set", "job-set-1")

      await expandRow("job-set-1")

      await waitFor(
        async () => {
          await clickOnJobRow(jobs[0].jobId)
          expect(router.state.location.search).toContain("g[0]=jobSet")
          expect(router.state.location.search).not.toContain("g[1]")
          expect(router.state.location.search).toContain(`sb=${jobs[0].jobId}`)
          expect(router.state.location.search).toContain("e[0]=jobSet%3Ajob-set-1")
        },
        { timeout: 3000 },
      )
    })

    it("should populate table state from query params", async () => {
      // Set query param to the same as the test above
      const jobs = [
        ...makeTestJobs(5, "queue-1", "job-set-1", JobState.Queued),
        ...makeTestJobs(10, "queue-2", "job-set-2", JobState.Pending),
        ...makeTestJobs(15, "queue-3", "job-set-3", JobState.Running),
      ]
      renderComponent(
        jobs,
        `?page=0&g[0]=jobSet&sort[id]=jobId&sort[desc]=true&pS=50&f[0][id]=jobSet&f[0][value]=job-set-1&f[0][match]=startsWith&e[0]=jobSet%3Ajob-set-1`,
      )

      await waitForFinishedLoading()

      // 1 jobset + jobs for expanded jobset
      await assertNumDataRowsShown(1 + 5)
    })

    it("should populate page index from query params", async () => {
      const jobs = makeTestJobs(51, "queue-1", "job-set-1", JobState.Queued)
      for (let i = 0; i < 51; i++) {
        jobs[i].jobId = "job-" + `${i}`.padStart(2, "0")
      }

      const { getAllByRole } = renderComponent(jobs, `?page=1&sort[id]=jobId&sort[desc]=false`)
      await waitForFinishedLoading()
      await waitFor(() => {
        const rows = getAllByRole("row")
        // The header, plus one row for the last element of `jobs`.
        expect(rows.length).toBe(2)
        expect(rows[1]).toHaveTextContent(jobs[50].jobId)
      })
    })
  })

  async function waitForFinishedLoading() {
    await waitFor(() => expect(screen.queryAllByRole("progressbar").length).toBe(0))
  }

  async function assertNumDataRowsShown(nDataRows: number) {
    await waitFor(
      async () => {
        const table = await screen.findByRole("table", { name: "Jobs table" })
        const rows = await within(table).findAllByRole("row")
        expect(rows.length).toBe(nDataRows + 1) // One row per data row, plus the header
      },
      { timeout: 3000 },
    )
  }

  async function groupByColumn(columnDisplayName: string) {
    const groupByDropdownButton = await screen.findByLabelText("Group by")
    await userEvent.click(groupByDropdownButton)

    const dropdown = await screen.findByRole("listbox")
    const colToGroup = await within(dropdown).findByText(columnDisplayName)
    await userEvent.click(colToGroup)
  }

  async function clearAllGroupings() {
    const clearGroupingButtons = screen.queryAllByRole("button", { name: /Clear grouping/i })
    for (const clearGroupingButton of clearGroupingButtons) {
      await userEvent.click(clearGroupingButton)
    }
  }

  async function expandRow(buttonText: string) {
    const rowToExpand = await screen.findByRole("row", {
      name: new RegExp(buttonText),
    })
    const expandButton = within(rowToExpand).getByRole("button", { name: "Expand row" })
    await userEvent.click(expandButton)
    await waitForFinishedLoading()
  }

  async function toggleSelectedRow(rowType: string, rowId: string) {
    const matchingRow = await screen.findByRole("row", { name: `${rowType}:${rowId}` })
    const checkbox = await within(matchingRow).findByRole("checkbox")
    await userEvent.click(checkbox)
  }

  async function getHeaderCell(columnDisplayName: string) {
    return await screen.findByRole("columnheader", { name: columnDisplayName })
  }

  async function filterTextColumnTo(columnDisplayName: string, filterText: string) {
    const headerCell = await getHeaderCell(columnDisplayName)
    const filterInput = await within(headerCell).findByRole("textbox")
    await userEvent.clear(filterInput)
    if (filterText.length > 0) {
      await userEvent.type(filterInput, filterText)
    }
  }

  async function toggleEnumFilterOptions(columnDisplayName: string, filterOptions: string[]) {
    const headerCell = await getHeaderCell(columnDisplayName)
    const dropdownTrigger = await within(headerCell).findByLabelText("Filter\u2026")
    await userEvent.click(dropdownTrigger)
    for (const filterOption of filterOptions) {
      const optionButton = await screen.findByRole("option", { name: filterOption })
      await userEvent.click(optionButton)
    }

    // Ensure the dropdown is closed
    await userEvent.tab()
  }

  async function toggleSorting(columnDisplayName: string) {
    const headerCell = await getHeaderCell(columnDisplayName)
    const sortButton = await within(headerCell).findByRole("button", { name: "Toggle sort" })
    await userEvent.click(sortButton)
  }

  async function triggerRefresh() {
    const button = await screen.findByRole("button", { name: "Refresh" })
    await userEvent.click(button)
  }

  async function addAnnotationColumn(annotationKey: string) {
    const editColumnsButton = await screen.findByRole("button", { name: /configure columns/i })
    await userEvent.click(editColumnsButton)

    const textbox = await screen.findByRole("textbox", { name: /annotation key/i })
    await userEvent.type(textbox, annotationKey)

    const saveButton = await screen.findByRole("button", { name: /add a column for annotation/i })
    await userEvent.click(saveButton)

    const closeButton = await screen.findByRole("button", { name: /close/i })
    await userEvent.click(closeButton)
  }

  async function clickOnJobRow(jobId: string) {
    const jobRow = await screen.findByRole("row", { name: new RegExp(jobId) })
    await userEvent.click(within(jobRow).getByText(jobId))
  }
})
