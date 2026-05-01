package com.legal.scraper.controller;

import com.legal.scraper.service.ArticleScraperService;
import com.legal.scraper.service.ReceiptScraperService;
import com.legal.scraper.util.BarcodeParser;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.File;
import java.util.HashSet;
import java.util.Set;

@RestController
@RequestMapping("/api")
@CrossOrigin(origins = "*")
public class ScraperController {

    @Autowired
    private ReceiptScraperService receiptScraperService;

    @Autowired
    private ArticleScraperService articleScraperService;

    @PostMapping("/scrape")
    public ResponseEntity<?> scrapeReceipts(
            @RequestParam("username") String username,
            @RequestParam("password") String password,
            @RequestParam(value = "date", required = false) String date,
            @RequestParam(value = "bookingType", required = false) String bookingType,
            @RequestParam(value = "barcodeFile", required = false) MultipartFile file) {

        try {
            Set<String> barcodeList = new HashSet<>();
            if (file != null && !file.isEmpty()) {
                barcodeList = BarcodeParser.parseBarcodes(file.getInputStream(), file.getOriginalFilename());
            }

            if (username == null || password == null) {
                return ResponseEntity.badRequest().body("Missing required fields.");
            }

            String zipPath = receiptScraperService.scrapeReceipts(username, password, barcodeList);
            
            File zipFile = new File(zipPath);
            return ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + zipFile.getName() + "\"")
                    .contentType(MediaType.parseMediaType("application/zip"))
                    .body(new FileSystemResource(zipFile));

        } catch (Exception e) {
            e.printStackTrace();
            return ResponseEntity.internalServerError().body("Failed to scrape receipts: " + e.getMessage());
        }
    }

    @PostMapping("/scrape-articles")
    public ResponseEntity<?> scrapeArticles(
            @RequestParam("username") String username,
            @RequestParam("password") String password,
            @RequestParam(value = "barcodeFile", required = false) MultipartFile file) {

        try {
            Set<String> barcodeList = new HashSet<>();
            if (file != null && !file.isEmpty()) {
                barcodeList = BarcodeParser.parseBarcodes(file.getInputStream(), file.getOriginalFilename());
            }

            if (username == null || password == null) {
                return ResponseEntity.badRequest().body("Missing required fields.");
            }

            String zipPath = articleScraperService.scrapeArticles(username, password, barcodeList);

            File zipFile = new File(zipPath);
            return ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + zipFile.getName() + "\"")
                    .contentType(MediaType.parseMediaType("application/zip"))
                    .body(new FileSystemResource(zipFile));

        } catch (Exception e) {
            e.printStackTrace();
            return ResponseEntity.internalServerError().body("Failed to scrape articles: " + e.getMessage());
        }
    }
}
