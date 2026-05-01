package com.legal.scraper.service;

import com.microsoft.playwright.*;
import org.springframework.stereotype.Service;

import java.io.FileOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

@Service
public class ArticleScraperService {

    public String scrapeArticles(String username, String password, Set<String> barcodeList) throws Exception {
        System.out.println("Starting Java Playwright Article Scraper");

        long timestamp = System.currentTimeMillis();
        String downloadDir = "downloads_articles_" + timestamp;
        Files.createDirectories(Paths.get(downloadDir));

        try (Playwright playwright = Playwright.create()) {
            BrowserType.LaunchPersistentContextOptions options = new BrowserType.LaunchPersistentContextOptions()
                    .setHeadless(false)
                    .setChannel("chrome")
                    .setAcceptDownloads(true);

            Path userDataDir = Paths.get("chrome_profile_article");
            BrowserContext context = playwright.chromium().launchPersistentContext(userDataDir, options);
            Page page = context.pages().isEmpty() ? context.newPage() : context.pages().get(0);

            page.navigate("https://app.indiapost.gov.in/customer-selfservice/login");

            try {
                page.waitForSelector("#customerid", new Page.WaitForSelectorOptions().setTimeout(15000));
                page.fill("#customerid", username);
                page.fill("#password", password);
                System.out.println("Credentials filled. Waiting for user to complete CAPTCHA...");
            } catch (Exception e) {
                System.out.println("Auto-fill failed, please enter manually.");
            }

            System.out.println("#######################################################");
            System.out.println("ACTION REQUIRED: Log in, go to Bulk Track, and trigger table load.");
            System.out.println("Please do this in the opened browser window.");
            System.out.println("#######################################################");

            page.waitForTimeout(60000); // 1 minute allowed for manual testing 

            context.close();
        }

        // Create Zip
        String zipName = "bulk_articles_" + timestamp + ".zip";
        zipFolder(Paths.get(downloadDir), Paths.get(zipName));
        return Paths.get(zipName).toAbsolutePath().toString();
    }

    private void zipFolder(Path sourceFolderPath, Path zipPath) throws Exception {
        try (ZipOutputStream zos = new ZipOutputStream(new FileOutputStream(zipPath.toFile()))) {
            Files.walk(sourceFolderPath).filter(path -> !Files.isDirectory(path)).forEach(path -> {
                ZipEntry zipEntry = new ZipEntry(sourceFolderPath.relativize(path).toString());
                try {
                    zos.putNextEntry(zipEntry);
                    Files.copy(path, zos);
                    zos.closeEntry();
                } catch (Exception e) {
                    System.err.println(e);
                }
            });
        }
    }
}
