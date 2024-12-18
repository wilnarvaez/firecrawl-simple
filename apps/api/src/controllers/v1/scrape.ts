import { Request, Response } from "express";
import { Logger } from "../../lib/logger";
import {
  Document,
  legacyDocumentConverter,
  legacyExtractorOptions,
  legacyScrapeOptions,
  RequestWithAuth,
  ScrapeRequest,
  scrapeRequestSchema,
  ScrapeResponse,
} from "./types";
import { v4 as uuidv4 } from "uuid";
import { addScrapeJobRaw, waitForJob } from "../../services/queue-jobs";
import { getJobPriority } from "../../lib/job-priority";
import { PlanType } from "../../types";

export async function scrapeController(
  req: RequestWithAuth<{}, ScrapeResponse, ScrapeRequest>,
  res: Response<ScrapeResponse>
) {
  req.body = scrapeRequestSchema.parse(req.body);
  let earlyReturn = false;

  const origin = req.body.origin;
  const timeout = req.body.timeout;
  const pageOptions = legacyScrapeOptions(req.body);
  const extractorOptions = req.body.extract ? legacyExtractorOptions(req.body.extract) : undefined;
  const jobId = uuidv4();

  const startTime = new Date().getTime();
  const jobPriority = await getJobPriority({
    plan: req.auth.plan as PlanType,
    team_id: req.auth.team_id,
    basePriority: 10,
  });

  const job = await addScrapeJobRaw(
    {
      url: req.body.url,
      mode: "single_urls",
      crawlerOptions: {},
      team_id: req.auth.team_id,
      pageOptions,
      extractorOptions,
      origin: req.body.origin,
      is_scrape: true,
    },
    {},
    jobId,
    jobPriority
  );

  let doc: any | undefined;
  try {
    doc = (await waitForJob(job.id, timeout))[0];
  } catch (e) {
    Logger.error(`Error in scrapeController: ${e}`);
    if (e instanceof Error && e.message.startsWith("Job wait")) {
      return res.status(408).json({
        success: false,
        error: "Request timed out",
      });
    } else {
      return res.status(500).json({
        success: false,
        error: `(Internal server error) - ${e && e?.message ? e.message : e} ${
          extractorOptions && extractorOptions.mode !== "markdown"
            ? " - Could be due to LLM parsing issues"
            : ""
        }`,
      });
    }
  }

  await job.remove();

  if (!doc) {
    console.error("!!! PANIC DOC IS", doc, job);
    return res.status(200).json({
      success: true,
      warning: "No page found",
      data: doc,
    });
  }

  delete doc.index;
  delete doc.provider;

  const endTime = new Date().getTime();

  if (earlyReturn) {
    // Don't bill if we're early returning
    return;
  }

  if (!pageOptions || !pageOptions.includeRawHtml) {
    if (doc && doc.rawHtml) {
      delete doc.rawHtml;
    }
  }

  if(pageOptions && pageOptions.includeExtract) {
    if(!pageOptions.includeMarkdown && doc && doc.markdown) {
      delete doc.markdown;
    }
  }

  return res.status(200).json({
    success: true,
    data: legacyDocumentConverter(doc),
    scrape_id: origin?.includes("website") ? jobId : undefined,
  });
}
